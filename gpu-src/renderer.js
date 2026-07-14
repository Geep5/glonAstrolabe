/**
 * TypeGPU/WebGPU renderer for glonAstrolabe.
 *
 * Replaces the three.js WebGLRenderer + EffectComposer stack:
 *   - instanced UV-sphere pipeline (lit planets, emissive-map "featured"
 *     agents, unlit transparent coronas)
 *   - parametric torus pipeline (agent local-orbit rings)
 *   - line pipeline (link curves, dashed halo rings, floor grid)
 *   - point lights + ambient, linear black fog, per-material ACES
 *     tonemapping (matching three's toneMapped:true/false split)
 *   - bloom post chain (bright-pass -> separable blur -> composite),
 *     the UnrealBloomPass stand-in
 *   - a 256x128xN rgba8unorm-srgb texture array for the canvas-baked
 *     procedural planet surfaces
 *
 * All shaders are TypeGPU `'use gpu'` functions, transpiled by
 * unplugin-typegpu at bundle time (see scripts/build-gpu.mjs).
 */

import tgpu, { d, std, common } from "typegpu";

export * from "./math.js";
export * from "./scene.js";
export { OrbitLite } from "./controls.js";
import { Group, nodeVisible } from "./scene.js";

const MAX_SPHERES = 4096;
const MAX_TORI = 256;
const MAX_LIGHTS = 8;
const MAX_LINE_VERTS = 98304;
const TEX_W = 256, TEX_H = 128, TEX_LAYERS = 32;

// Bloom tuning — stands in for `new UnrealBloomPass(res, 0.55, 0.55)`.
const BLOOM = { strength: 0.55, threshold: 0.8, knee: 0.35, iterations: 3 };
const EXPOSURE = 1.15;                      // renderer.toneMappingExposure
const FOG_NEAR = 40, FOG_FAR = 140;         // scene.fog = Fog(0x000000, 40, 140)

// ── Data schemas ───────────────────────────────────────────────────

const CameraU = d.struct({
	viewProj: d.mat4x4f,
	camPosFogNear: d.vec4f,     // xyz camera position, w fogNear
	fogFarExposure: d.vec4f,    // x fogFar, y exposure
});

const LightItem = d.struct({
	a: d.vec4f,                 // xyz position, w intensity
	b: d.vec4f,                 // rgb color, w cutoff distance (0 = none)
	c: d.vec4f,                 // x decay exponent
});
const LightingU = d.struct({
	counts: d.vec4f,            // x = active point-light count
	ambient: d.vec4f,           // rgb ambient irradiance
	lights: d.arrayOf(LightItem, MAX_LIGHTS),
});

// Per-instance data. `params` = (texLayer|tubeRadius, mode, alpha,
// toneMapped); `rot` = (tiltX, spinY). Spheres and tori share the
// struct so both instance buffers use one bind-group layout.
const SphereInst = d.struct({
	pos: d.vec3f,
	scale: d.f32,
	color: d.vec4f,
	emissive: d.vec3f,
	emissiveIntensity: d.f32,
	params: d.vec4f,
	rot: d.vec4f,
});
const INST_FLOATS = 20; // must equal d.sizeOf(SphereInst) / 4 — checked at init

// ── Bind group layouts ─────────────────────────────────────────────

const frameLayout = tgpu.bindGroupLayout({
	cam: { uniform: CameraU },
	lighting: { uniform: LightingU },
	planetTex: { texture: d.texture2dArray(d.f32) },
	planetSamp: { sampler: "filtering" },
});
const instLayout = tgpu.bindGroupLayout({
	instances: { storage: d.arrayOf(SphereInst) },
});
const postLayout = tgpu.bindGroupLayout({
	src: { texture: d.texture2d(d.f32) },
	samp: { sampler: "filtering" },
	params: { uniform: d.vec4f },   // x threshold, y knee (bright) | xy dir (blur)
});
const compLayout = tgpu.bindGroupLayout({
	sceneT: { texture: d.texture2d(d.f32) },
	bloomT: { texture: d.texture2d(d.f32) },
	samp: { sampler: "filtering" },
	params: { uniform: d.vec4f },   // x bloom strength
});

// ── Vertex layouts (loose/packed) ──────────────────────────────────

const meshVertLayout = tgpu.vertexLayout(
	d.disarrayOf(d.unstruct({ pos: d.float32x3, normal: d.float32x3, uv: d.float32x2 })),
);
const torusVertLayout = tgpu.vertexLayout(
	d.disarrayOf(d.unstruct({ ang: d.float32x4 })),
);
const lineVertLayout = tgpu.vertexLayout(
	d.disarrayOf(d.unstruct({ pos: d.float32x3, color: d.float32x4, dash: d.float32 })),
);

// ── Shader helpers ─────────────────────────────────────────────────

const acesTonemap = (c) => {
	"use gpu";
	// Narkowicz ACES approximation, matching three's ACESFilmic feel.
	const num = std.mul(c, std.add(std.mul(c, 2.51), d.vec3f(0.03)));
	const den = std.add(std.mul(c, std.add(std.mul(c, 2.43), d.vec3f(0.59))), d.vec3f(0.14));
	return std.clamp(std.div(num, den), d.vec3f(0), d.vec3f(1));
};

const fogFactor = (wp) => {
	"use gpu";
	const camPos = frameLayout.$.cam.camPosFogNear.xyz;
	const fogNear = frameLayout.$.cam.camPosFogNear.w;
	const fogFar = frameLayout.$.cam.fogFarExposure.x;
	const dist = std.distance(wp, camPos);
	return std.clamp((fogFar - dist) / std.max(fogFar - fogNear, 0.0001), 0, 1);
};

// Rotate by tilt around X after spin around Y (three Euler XYZ with z=0).
const rotTiltSpin = (p, tilt, spin) => {
	"use gpu";
	const cy = std.cos(spin);
	const sy = std.sin(spin);
	const x1 = p.x * cy + p.z * sy;
	const z1 = -p.x * sy + p.z * cy;
	const ct = std.cos(tilt);
	const st = std.sin(tilt);
	const y2 = p.y * ct - z1 * st;
	const z2 = p.y * st + z1 * ct;
	return d.vec3f(x1, y2, z2);
};

// ── Sphere shaders ─────────────────────────────────────────────────

const sphereVaryings = {
	position: d.builtin.position,
	wp: d.vec3f,
	nrm: d.vec3f,
	fuv: d.vec2f,
	vColor: d.vec4f,
	vEmi: d.vec4f,
	vParams: d.vec4f,
};

const sphereVert = tgpu.vertexFn({
	in: { pos: d.vec3f, normal: d.vec3f, uv: d.vec2f, iid: d.builtin.instanceIndex },
	out: sphereVaryings,
})((input) => {
	"use gpu";
	const inst = instLayout.$.instances[input.iid];
	const local = rotTiltSpin(input.pos, inst.rot.x, inst.rot.y);
	const nrm = rotTiltSpin(input.normal, inst.rot.x, inst.rot.y);
	const wp = std.add(std.mul(local, inst.scale), inst.pos);
	return {
		position: std.mul(frameLayout.$.cam.viewProj, d.vec4f(wp, 1)),
		wp: d.vec3f(wp),
		nrm: d.vec3f(nrm),
		fuv: d.vec2f(input.uv),
		vColor: d.vec4f(inst.color),
		vEmi: d.vec4f(inst.emissive, inst.emissiveIntensity),
		vParams: d.vec4f(inst.params),
	};
});

const sphereFrag = tgpu.fragmentFn({
	in: sphereVaryings,
	out: d.vec4f,
})((input) => {
	"use gpu";
	const texLayer = input.vParams.x;
	const mode = input.vParams.y;
	const layerIdx = d.u32(std.max(texLayer, 0));
	const texC = std.textureSampleLevel(
		frameLayout.$.planetTex, frameLayout.$.planetSamp, input.fuv, layerIdx, 0,
	);

	let albedo = d.vec3f(input.vColor.xyz);
	if (texLayer >= 0 && mode < 0.5) {
		albedo = std.mul(albedo, texC.xyz);
	}
	let emiTint = d.vec3f(1, 1, 1);
	if (texLayer >= 0 && mode > 0.5) {
		emiTint = d.vec3f(texC.xyz);
	}
	const emission = std.mul(std.mul(emiTint, input.vEmi.xyz), input.vEmi.w);

	// Point-light shading, matching three's physical punctual falloff.
	const n = std.normalize(input.nrm);
	let irradiance = d.vec3f(frameLayout.$.lighting.ambient.xyz);
	const count = frameLayout.$.lighting.counts.x;
	for (const i of std.range(MAX_LIGHTS)) {
		if (d.f32(i) < count) {
			const L = frameLayout.$.lighting.lights[i];
			const toL = std.sub(L.a.xyz, input.wp);
			const dist = std.max(std.length(toL), 0.0001);
			const nl = std.max(std.dot(n, std.div(toL, dist)), 0);
			let atten = 1 / std.max(std.pow(dist, L.c.x), 0.01);
			const cutoff = L.b.w;
			if (cutoff > 0) {
				const q = std.clamp(1 - std.pow(dist / cutoff, 4), 0, 1);
				atten = atten * q * q;
			}
			irradiance = std.add(irradiance, std.mul(L.b.xyz, L.a.w * nl * atten));
		}
	}

	let color = std.add(std.mul(std.mul(albedo, irradiance), 0.3183098861837907), emission);
	color = std.mul(color, fogFactor(input.wp));
	if (input.vParams.w > 0.5) {
		color = acesTonemap(std.mul(color, frameLayout.$.cam.fogFarExposure.y));
	}
	return d.vec4f(color, 1);
});

// Unlit transparent (coronas, glow shells, tori) — mode 2.
const unlitFrag = tgpu.fragmentFn({
	in: sphereVaryings,
	out: d.vec4f,
})((input) => {
	"use gpu";
	let color = d.vec3f(input.vColor.xyz);
	color = std.mul(color, fogFactor(input.wp));
	if (input.vParams.w > 0.5) {
		color = acesTonemap(std.mul(color, frameLayout.$.cam.fogFarExposure.y));
	}
	return d.vec4f(color, input.vParams.z);
});

// ── Torus shaders (parametric: per-instance radius + tube) ─────────

const torusVert = tgpu.vertexFn({
	in: { ang: d.vec4f, iid: d.builtin.instanceIndex },
	out: sphereVaryings,
})((input) => {
	"use gpu";
	const inst = instLayout.$.instances[input.iid];
	const R = inst.scale;
	const tube = inst.params.x;
	const ring = R + tube * input.ang.z;
	const wp = std.add(
		d.vec3f(input.ang.x * ring, tube * input.ang.w, input.ang.y * ring),
		inst.pos,
	);
	return {
		position: std.mul(frameLayout.$.cam.viewProj, d.vec4f(wp, 1)),
		wp: d.vec3f(wp),
		nrm: d.vec3f(0, 1, 0),
		fuv: d.vec2f(0, 0),
		vColor: d.vec4f(inst.color),
		vEmi: d.vec4f(inst.emissive, inst.emissiveIntensity),
		vParams: d.vec4f(-1, inst.params.y, inst.params.z, inst.params.w),
	};
});

// ── Line shaders ───────────────────────────────────────────────────

const lineVert = tgpu.vertexFn({
	in: { pos: d.vec3f, color: d.vec4f, dash: d.f32 },
	out: { position: d.builtin.position, vColor: d.vec4f, vDash: d.f32, wp: d.vec3f },
})((input) => {
	"use gpu";
	return {
		position: std.mul(frameLayout.$.cam.viewProj, d.vec4f(input.pos, 1)),
		vColor: d.vec4f(input.color),
		vDash: input.dash,
		wp: d.vec3f(input.pos),
	};
});

const lineFrag = tgpu.fragmentFn({
	in: { vColor: d.vec4f, vDash: d.f32, wp: d.vec3f },
	out: d.vec4f,
})((input) => {
	"use gpu";
	// dashSize 0.10 / gap 0.06 in unit-circle arc space: period 0.16.
	let mask = d.f32(1);
	if (input.vDash >= 0) {
		if (std.fract(input.vDash * 6.25) > 0.625) {
			mask = d.f32(0);
		}
	}
	let rgb = d.vec3f(input.vColor.xyz);
	rgb = std.mul(rgb, fogFactor(input.wp));
	rgb = acesTonemap(std.mul(rgb, frameLayout.$.cam.fogFarExposure.y));
	return d.vec4f(rgb, input.vColor.w * mask);
});

// ── Post-processing shaders ────────────────────────────────────────

const brightFrag = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	"use gpu";
	const c = std.textureSampleLevel(postLayout.$.src, postLayout.$.samp, input.uv, 0);
	const luma = std.dot(c.xyz, d.vec3f(0.2126, 0.7152, 0.0722));
	const t = postLayout.$.params.x;
	const knee = postLayout.$.params.y;
	const w = std.smoothstep(t, t + knee, luma);
	return d.vec4f(std.mul(c.xyz, w), 1);
});

const blurFrag = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	"use gpu";
	const dims = std.textureDimensions(postLayout.$.src);
	const texel = std.div(d.vec2f(1, 1), d.vec2f(d.f32(dims.x), d.f32(dims.y)));
	const dir = std.mul(postLayout.$.params.xy, texel);
	let acc = std.mul(std.textureSampleLevel(postLayout.$.src, postLayout.$.samp, input.uv, 0).xyz, 0.227027);
	const o1 = std.mul(dir, 1.3846153846);
	const o2 = std.mul(dir, 3.2307692308);
	acc = std.add(acc, std.mul(std.textureSampleLevel(postLayout.$.src, postLayout.$.samp, std.add(input.uv, o1), 0).xyz, 0.3162162162));
	acc = std.add(acc, std.mul(std.textureSampleLevel(postLayout.$.src, postLayout.$.samp, std.sub(input.uv, o1), 0).xyz, 0.3162162162));
	acc = std.add(acc, std.mul(std.textureSampleLevel(postLayout.$.src, postLayout.$.samp, std.add(input.uv, o2), 0).xyz, 0.0702702703));
	acc = std.add(acc, std.mul(std.textureSampleLevel(postLayout.$.src, postLayout.$.samp, std.sub(input.uv, o2), 0).xyz, 0.0702702703));
	return d.vec4f(acc, 1);
});

const compositeFrag = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	"use gpu";
	const scene = std.textureSampleLevel(compLayout.$.sceneT, compLayout.$.samp, input.uv, 0);
	const bloom = std.textureSampleLevel(compLayout.$.bloomT, compLayout.$.samp, input.uv, 0);
	const strength = compLayout.$.params.x;
	const rgb = std.add(scene.xyz, std.mul(bloom.xyz, strength));
	const bloomLuma = std.dot(bloom.xyz, d.vec3f(0.299, 0.587, 0.114));
	const alpha = std.min(scene.w + bloomLuma * strength, 1);
	return d.vec4f(rgb, alpha);
});

// ── Geometry generation ────────────────────────────────────────────

function buildUvSphere(widthSeg = 32, heightSeg = 20) {
	const verts = [];
	const indices = [];
	for (let iy = 0; iy <= heightSeg; iy++) {
		const v = iy / heightSeg;
		const phi = v * Math.PI;
		for (let ix = 0; ix <= widthSeg; ix++) {
			const u = ix / widthSeg;
			const theta = u * Math.PI * 2;
			const x = -Math.cos(theta) * Math.sin(phi);
			const y = Math.cos(phi);
			const z = Math.sin(theta) * Math.sin(phi);
			verts.push(x, y, z, x, y, z, u, 1 - v);
		}
	}
	const row = widthSeg + 1;
	for (let iy = 0; iy < heightSeg; iy++) {
		for (let ix = 0; ix < widthSeg; ix++) {
			const a = iy * row + ix, b = a + row;
			if (iy !== 0) indices.push(a, b, a + 1);
			if (iy !== heightSeg - 1) indices.push(a + 1, b, b + 1);
		}
	}
	return { verts: new Float32Array(verts), indices: new Uint32Array(indices) };
}

function buildTorusParam(radialSeg = 48, tubularSeg = 10) {
	const verts = [];
	const indices = [];
	for (let i = 0; i <= radialSeg; i++) {
		const u = (i / radialSeg) * Math.PI * 2;
		for (let j = 0; j <= tubularSeg; j++) {
			const v = (j / tubularSeg) * Math.PI * 2;
			verts.push(Math.cos(u), Math.sin(u), Math.cos(v), Math.sin(v));
		}
	}
	const row = tubularSeg + 1;
	for (let i = 0; i < radialSeg; i++) {
		for (let j = 0; j < tubularSeg; j++) {
			const a = i * row + j, b = a + row;
			indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}
	return { verts: new Float32Array(verts), indices: new Uint32Array(indices) };
}

// ── Renderer ───────────────────────────────────────────────────────

const ALPHA_BLEND = {
	color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
	alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

export async function initRenderer(canvas) {
	if (!navigator.gpu) {
		throw new Error("WebGPU is not available in this browser — glonAstrolabe now renders with TypeGPU/WebGPU.");
	}
	const root = await tgpu.init({ device: { optionalFeatures: [] } }).catch(() => tgpu.init());
	const device = root.device;
	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	const context = root.configureContext({ canvas, alphaMode: "premultiplied" });

	if (d.sizeOf(SphereInst) !== INST_FLOATS * 4) {
		throw new Error(`SphereInst layout drifted: ${d.sizeOf(SphereInst)} bytes`);
	}

	// Static geometry
	const sphereGeo = buildUvSphere();
	const torusGeo = buildTorusParam();
	const sphereVB = root.createBuffer(meshVertLayout.schemaForCount(sphereGeo.verts.length / 8)).$usage("vertex");
	device.queue.writeBuffer(root.unwrap(sphereVB), 0, sphereGeo.verts);
	const sphereIB = root.createBuffer(d.arrayOf(d.u32, sphereGeo.indices.length)).$usage("index");
	device.queue.writeBuffer(root.unwrap(sphereIB), 0, sphereGeo.indices);
	const torusVB = root.createBuffer(torusVertLayout.schemaForCount(torusGeo.verts.length / 4)).$usage("vertex");
	device.queue.writeBuffer(root.unwrap(torusVB), 0, torusGeo.verts);
	const torusIB = root.createBuffer(d.arrayOf(d.u32, torusGeo.indices.length)).$usage("index");
	device.queue.writeBuffer(root.unwrap(torusIB), 0, torusGeo.indices);

	// Dynamic buffers + CPU mirrors
	const camBuf = root.createBuffer(CameraU).$usage("uniform");
	const camData = new Float32Array(24);
	const lightBuf = root.createBuffer(LightingU).$usage("uniform");
	const lightData = new Float32Array(8 + MAX_LIGHTS * 12);
	const opaqueBuf = root.createBuffer(d.arrayOf(SphereInst, MAX_SPHERES)).$usage("storage");
	const transBuf = root.createBuffer(d.arrayOf(SphereInst, MAX_SPHERES)).$usage("storage");
	const torusBuf = root.createBuffer(d.arrayOf(SphereInst, MAX_TORI)).$usage("storage");
	const opaqueData = new Float32Array(MAX_SPHERES * INST_FLOATS);
	const transData = new Float32Array(MAX_SPHERES * INST_FLOATS);
	const torusData = new Float32Array(MAX_TORI * INST_FLOATS);
	const lineVB = root.createBuffer(lineVertLayout.schemaForCount(MAX_LINE_VERTS)).$usage("vertex");
	const lineData = new Float32Array(MAX_LINE_VERTS * 8);

	// Planet texture array (canvas-baked equirect surfaces, sRGB)
	// 'render' usage is required because copyExternalImageToTexture
	// demands CopyDst *and* RenderAttachment on the destination.
	const planetTex = root.createTexture({
		size: [TEX_W, TEX_H, TEX_LAYERS],
		format: "rgba8unorm-srgb",
	}).$usage("sampled", "render");
	const planetTexView = planetTex.createView(d.texture2dArray(d.f32));
	const planetSampler = root.createSampler({
		addressModeU: "repeat",
		addressModeV: "clamp-to-edge",
		magFilter: "linear",
		minFilter: "linear",
	});
	let nextTexLayer = 0;

	const postSampler = root.createSampler({
		addressModeU: "clamp-to-edge",
		addressModeV: "clamp-to-edge",
		magFilter: "linear",
		minFilter: "linear",
	});

	// Post-chain params
	const brightParams = root.createBuffer(d.vec4f, d.vec4f(BLOOM.threshold, BLOOM.knee, 0, 0)).$usage("uniform");
	const dirHParams = root.createBuffer(d.vec4f, d.vec4f(1, 0, 0, 0)).$usage("uniform");
	const dirVParams = root.createBuffer(d.vec4f, d.vec4f(0, 1, 0, 0)).$usage("uniform");
	const compParams = root.createBuffer(d.vec4f, d.vec4f(BLOOM.strength, 0, 0, 0)).$usage("uniform");

	const frameBG = root.createBindGroup(frameLayout, {
		cam: camBuf, lighting: lightBuf, planetTex: planetTexView, planetSamp: planetSampler,
	});
	const opaqueBG = root.createBindGroup(instLayout, { instances: opaqueBuf });
	const transBG = root.createBindGroup(instLayout, { instances: transBuf });
	const torusBG = root.createBindGroup(instLayout, { instances: torusBuf });

	// ── Pipelines ────────────────────────────────────────────────
	const depthState = (write) => ({
		format: "depth24plus",
		depthWriteEnabled: write,
		depthCompare: "less",
	});

	const opaquePipe = root.createRenderPipeline({
		attribs: { ...meshVertLayout.attrib },
		vertex: sphereVert,
		fragment: sphereFrag,
		targets: { format: "rgba16float" },
		depthStencil: depthState(true),
		primitive: { topology: "triangle-list", cullMode: "back" },
	});
	const transPipe = root.createRenderPipeline({
		attribs: { ...meshVertLayout.attrib },
		vertex: sphereVert,
		fragment: unlitFrag,
		targets: { format: "rgba16float", blend: ALPHA_BLEND },
		depthStencil: depthState(false),
		primitive: { topology: "triangle-list", cullMode: "back" },
	});
	const torusPipe = root.createRenderPipeline({
		attribs: { ...torusVertLayout.attrib },
		vertex: torusVert,
		fragment: unlitFrag,
		targets: { format: "rgba16float", blend: ALPHA_BLEND },
		depthStencil: depthState(false),
		primitive: { topology: "triangle-list" },
	});
	const linePipe = root.createRenderPipeline({
		attribs: { ...lineVertLayout.attrib },
		vertex: lineVert,
		fragment: lineFrag,
		targets: { format: "rgba16float", blend: ALPHA_BLEND },
		depthStencil: depthState(false),
		primitive: { topology: "line-list" },
	});
	const brightPipe = root.createRenderPipeline({
		vertex: common.fullScreenTriangle,
		fragment: brightFrag,
		targets: { format: "rgba16float" },
	});
	const blurPipe = root.createRenderPipeline({
		vertex: common.fullScreenTriangle,
		fragment: blurFrag,
		targets: { format: "rgba16float" },
	});
	const compositePipe = root.createRenderPipeline({
		vertex: common.fullScreenTriangle,
		fragment: compositeFrag,
		targets: { format: presentationFormat },
	});

	// ── Render targets (recreated on resize) ─────────────────────
	let sceneTex = null, depthTex = null, bloomA = null, bloomB = null;
	let sceneRenderView, sceneSampView, depthView, bloomAView, bloomASampView, bloomBView, bloomBSampView;
	let brightBG, blurHBG, blurVBG, compBG;
	let width = 2, height = 2;

	function resize(w, h, dpr) {
		width = Math.max(2, Math.floor(w * dpr));
		height = Math.max(2, Math.floor(h * dpr));
		canvas.width = width;
		canvas.height = height;
		for (const t of [sceneTex, depthTex, bloomA, bloomB]) t?.destroy?.();

		sceneTex = root.createTexture({ size: [width, height], format: "rgba16float" }).$usage("render", "sampled");
		depthTex = root.createTexture({ size: [width, height], format: "depth24plus" }).$usage("render");
		const hw = Math.max(2, width >> 1), hh = Math.max(2, height >> 1);
		bloomA = root.createTexture({ size: [hw, hh], format: "rgba16float" }).$usage("render", "sampled");
		bloomB = root.createTexture({ size: [hw, hh], format: "rgba16float" }).$usage("render", "sampled");

		sceneRenderView = sceneTex.createView("render");
		sceneSampView = sceneTex.createView(d.texture2d(d.f32));
		depthView = depthTex.createView("render");
		bloomAView = bloomA.createView("render");
		bloomASampView = bloomA.createView(d.texture2d(d.f32));
		bloomBView = bloomB.createView("render");
		bloomBSampView = bloomB.createView(d.texture2d(d.f32));

		brightBG = root.createBindGroup(postLayout, { src: sceneSampView, samp: postSampler, params: brightParams });
		blurHBG = root.createBindGroup(postLayout, { src: bloomASampView, samp: postSampler, params: dirHParams });
		blurVBG = root.createBindGroup(postLayout, { src: bloomBSampView, samp: postSampler, params: dirVParams });
		compBG = root.createBindGroup(compLayout, { sceneT: sceneSampView, bloomT: bloomASampView, samp: postSampler, params: compParams });
	}
	resize(canvas.clientWidth || 800, canvas.clientHeight || 600, Math.min(2, globalThis.devicePixelRatio || 1));

	// Upload a canvas-baked planet surface into the next texture-array
	// layer; returns the layer index for per-instance use.
	function uploadPlanetTexture(sourceCanvas) {
		if (nextTexLayer >= TEX_LAYERS) {
			console.warn("planet texture array full; reusing layer 0");
			return 0;
		}
		const layer = nextTexLayer++;
		device.queue.copyExternalImageToTexture(
			{ source: sourceCanvas },
			{ texture: root.unwrap(planetTex), origin: { x: 0, y: 0, z: layer } },
			[TEX_W, TEX_H, 1],
		);
		return layer;
	}

	// ── Per-frame packing ────────────────────────────────────────

	const scene = new Group("root");
	const collections = { opaque: 0, trans: 0, torus: 0, lineVerts: 0, lights: 0 };
	let ambientR = 0, ambientG = 0, ambientB = 0;

	function packSphere(h) {
		const isTrans = h.mode === 2;
		const data = isTrans ? transData : opaqueData;
		const n = isTrans ? collections.trans : collections.opaque;
		if (n >= MAX_SPHERES) return;
		const o = n * INST_FLOATS;
		const m = h.material;
		data[o] = h.position.x; data[o + 1] = h.position.y; data[o + 2] = h.position.z;
		data[o + 3] = h.scale.value;
		data[o + 4] = m.color.r; data[o + 5] = m.color.g; data[o + 6] = m.color.b; data[o + 7] = 1;
		data[o + 8] = m.emissive.r; data[o + 9] = m.emissive.g; data[o + 10] = m.emissive.b;
		data[o + 11] = m.emissiveIntensity;
		data[o + 12] = h.texLayer; data[o + 13] = h.mode; data[o + 14] = m.opacity; data[o + 15] = h.toneMapped ? 1 : 0;
		data[o + 16] = h.rotation.x; data[o + 17] = h.rotation.y; data[o + 18] = 0; data[o + 19] = 0;
		if (isTrans) collections.trans++; else collections.opaque++;
	}

	function packTorus(h) {
		if (collections.torus >= MAX_TORI) return;
		const o = collections.torus * INST_FLOATS;
		const m = h.material;
		torusData[o] = h.position.x; torusData[o + 1] = h.position.y; torusData[o + 2] = h.position.z;
		torusData[o + 3] = h.radius;
		torusData[o + 4] = m.color.r; torusData[o + 5] = m.color.g; torusData[o + 6] = m.color.b; torusData[o + 7] = 1;
		torusData[o + 8] = 0; torusData[o + 9] = 0; torusData[o + 10] = 0; torusData[o + 11] = 0;
		torusData[o + 12] = h.tube; torusData[o + 13] = 2; torusData[o + 14] = m.opacity; torusData[o + 15] = 1;
		torusData[o + 16] = 0; torusData[o + 17] = 0; torusData[o + 18] = 0; torusData[o + 19] = 0;
		collections.torus++;
	}

	function emitLineVert(x, y, z, r, g, b, a, dash) {
		const n = collections.lineVerts;
		if (n >= MAX_LINE_VERTS) return;
		const o = n * 8;
		lineData[o] = x; lineData[o + 1] = y; lineData[o + 2] = z;
		lineData[o + 3] = r; lineData[o + 4] = g; lineData[o + 5] = b; lineData[o + 6] = a;
		lineData[o + 7] = dash;
		collections.lineVerts++;
	}

	function packLine(h) {
		const { r, g, b } = h.material.color;
		const a = h.material.opacity;
		if (a < 0.004) return;
		const p = h.points;
		const count = p.length / 3;
		if (h.mode === "segments") {
			for (let i = 0; i + 1 < count; i += 2) {
				emitLineVert(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], r, g, b, a, -1);
				emitLineVert(p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5], r, g, b, a, -1);
			}
		} else {
			for (let i = 0; i + 1 < count; i++) {
				emitLineVert(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], r, g, b, a, -1);
				emitLineVert(p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5], r, g, b, a, -1);
			}
		}
	}

	function packRing(h) {
		const a = h.material.opacity;
		if (a < 0.004) return;
		const { r, g, b } = h.material.color;
		const s = h.scale.value;
		const { x: cx, y: cy, z: cz } = h.position;
		const SEG = h.segments;
		const step = (Math.PI * 2) / SEG;
		for (let j = 0; j < SEG; j++) {
			const t0 = j * step, t1 = (j + 1) * step;
			emitLineVert(cx + Math.cos(t0) * s, cy, cz + Math.sin(t0) * s, r, g, b, a, t0);
			emitLineVert(cx + Math.cos(t1) * s, cy, cz + Math.sin(t1) * s, r, g, b, a, t1);
		}
	}

	function packGrid(h) {
		const a = h.material.opacity;
		const half = h.size / 2;
		const step = h.size / h.divisions;
		const center = h.divisions / 2;
		const y = h.position.y;
		for (let i = 0; i <= h.divisions; i++) {
			const k = -half + i * step;
			const c = i === center ? h.colorCenter : h.colorGrid;
			emitLineVert(-half, y, k, c.r, c.g, c.b, a, -1);
			emitLineVert(half, y, k, c.r, c.g, c.b, a, -1);
			emitLineVert(k, y, -half, c.r, c.g, c.b, a, -1);
			emitLineVert(k, y, half, c.r, c.g, c.b, a, -1);
		}
	}

	function packLight(h) {
		if (collections.lights >= MAX_LIGHTS) return;
		if (h.intensity <= 0.0001) return;
		const o = 8 + collections.lights * 12;
		lightData[o] = h.position.x; lightData[o + 1] = h.position.y; lightData[o + 2] = h.position.z;
		lightData[o + 3] = h.intensity;
		lightData[o + 4] = h.color.r; lightData[o + 5] = h.color.g; lightData[o + 6] = h.color.b;
		lightData[o + 7] = h.distance || 0;
		lightData[o + 8] = h.decay ?? 2;
		collections.lights++;
	}

	function walk(node) {
		if (node.visible === false) return;
		switch (node.kind) {
			case "sphere": packSphere(node); break;
			case "torus": packTorus(node); break;
			case "line": packLine(node); break;
			case "ring": packRing(node); break;
			case "grid": packGrid(node); break;
			case "pointlight": packLight(node); break;
			case "ambient":
				ambientR += node.color.r * node.intensity;
				ambientG += node.color.g * node.intensity;
				ambientB += node.color.b * node.intensity;
				break;
		}
		if (node.children) for (const c of node.children) walk(c);
	}

	function render(camera) {
		camera.updateMatrices();
		camData.set(camera.viewProj, 0);
		camData[16] = camera.position.x; camData[17] = camera.position.y; camData[18] = camera.position.z;
		camData[19] = FOG_NEAR;
		camData[20] = FOG_FAR; camData[21] = EXPOSURE;
		device.queue.writeBuffer(root.unwrap(camBuf), 0, camData);

		collections.opaque = 0; collections.trans = 0; collections.torus = 0;
		collections.lineVerts = 0; collections.lights = 0;
		ambientR = ambientG = ambientB = 0;
		walk(scene);

		lightData[0] = collections.lights;
		lightData[4] = ambientR; lightData[5] = ambientG; lightData[6] = ambientB;
		device.queue.writeBuffer(root.unwrap(lightBuf), 0, lightData);
		if (collections.opaque > 0) {
			device.queue.writeBuffer(root.unwrap(opaqueBuf), 0, opaqueData, 0, collections.opaque * INST_FLOATS);
		}
		if (collections.trans > 0) {
			device.queue.writeBuffer(root.unwrap(transBuf), 0, transData, 0, collections.trans * INST_FLOATS);
		}
		if (collections.torus > 0) {
			device.queue.writeBuffer(root.unwrap(torusBuf), 0, torusData, 0, collections.torus * INST_FLOATS);
		}
		if (collections.lineVerts > 0) {
			device.queue.writeBuffer(root.unwrap(lineVB), 0, lineData, 0, collections.lineVerts * 8);
		}

		// Opaque pass also clears color + depth.
		opaquePipe
			.with(frameBG).with(opaqueBG)
			.with(meshVertLayout, sphereVB)
			.withColorAttachment({ view: sceneRenderView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } })
			.withDepthStencilAttachment({ view: depthView, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 })
			.withIndexBuffer(sphereIB)
			.drawIndexed(sphereGeo.indices.length, collections.opaque);

		if (collections.lineVerts > 0) {
			linePipe
				.with(frameBG)
				.with(lineVertLayout, lineVB)
				.withColorAttachment({ view: sceneRenderView, loadOp: "load", storeOp: "store" })
				.withDepthStencilAttachment({ view: depthView, depthLoadOp: "load", depthStoreOp: "store" })
				.draw(collections.lineVerts);
		}
		if (collections.trans > 0) {
			transPipe
				.with(frameBG).with(transBG)
				.with(meshVertLayout, sphereVB)
				.withColorAttachment({ view: sceneRenderView, loadOp: "load", storeOp: "store" })
				.withDepthStencilAttachment({ view: depthView, depthLoadOp: "load", depthStoreOp: "store" })
				.withIndexBuffer(sphereIB)
				.drawIndexed(sphereGeo.indices.length, collections.trans);
		}
		if (collections.torus > 0) {
			torusPipe
				.with(frameBG).with(torusBG)
				.with(torusVertLayout, torusVB)
				.withColorAttachment({ view: sceneRenderView, loadOp: "load", storeOp: "store" })
				.withDepthStencilAttachment({ view: depthView, depthLoadOp: "load", depthStoreOp: "store" })
				.withIndexBuffer(torusIB)
				.drawIndexed(torusGeo.indices.length, collections.torus);
		}

		// Bloom chain: bright-pass -> ping-pong blur -> composite.
		brightPipe.with(brightBG)
			.withColorAttachment({ view: bloomAView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } })
			.draw(3);
		for (let i = 0; i < BLOOM.iterations; i++) {
			blurPipe.with(blurHBG)
				.withColorAttachment({ view: bloomBView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } })
				.draw(3);
			blurPipe.with(blurVBG)
				.withColorAttachment({ view: bloomAView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } })
				.draw(3);
		}
		compositePipe.with(compBG)
			.withColorAttachment({ view: context, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } })
			.draw(3);
	}

	return {
		root,
		domElement: canvas,
		scene,
		render,
		resize,
		uploadPlanetTexture,
	};
}
