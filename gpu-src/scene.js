/**
 * Retained-mode scene shim over the TypeGPU renderer.
 *
 * Mirrors the tiny slice of the three.js object model that cosmos.js
 * and main.js actually use — position/scale/visible/userData handles
 * plus a Group with add/remove/traverse — so the renderer can walk a
 * scene graph while the app code stays close to its original shape.
 */

import { Vector3, Color } from "./math.js";

// Uniform scale that supports the `.setScalar()/.multiplyScalar()/.x`
// calls sprinkled through cosmos.js and main.js.
export class UniformScale {
	constructor(v = 1) { this.value = v; }
	setScalar(s) { this.value = s; return this; }
	multiplyScalar(s) { this.value *= s; return this; }
	get x() { return this.value; }
}

let nextId = 1;

class Node {
	constructor() {
		this.id = nextId++;
		this.parent = null;
		this.visible = true;
		this.userData = {};
		this.name = "";
	}
	traverse(fn) { fn(this); }
}

export class Group extends Node {
	constructor(name = "") {
		super();
		this.name = name;
		this.children = [];
	}
	add(...nodes) {
		for (const n of nodes) {
			if (n.parent) n.parent.remove(n);
			n.parent = this;
			this.children.push(n);
		}
		return this;
	}
	remove(...nodes) {
		for (const n of nodes) {
			const i = this.children.indexOf(n);
			if (i >= 0) { this.children.splice(i, 1); n.parent = null; }
		}
		return this;
	}
	traverse(fn) {
		fn(this);
		for (const c of this.children) c.traverse(fn);
	}
}

// Shading modes for SphereHandle (see renderer shader):
//   0 — lit surface: albedo (= color × optional texture) shaded by
//       point lights, plus emissive·intensity glow (MeshLambert-ish)
//   1 — emissive-map surface: texture × emissive × intensity, unlit
//       (the "featured"/agent look, MeshStandard emissiveMap-ish)
//   2 — unlit transparent: color × opacity, no lighting (MeshBasic-ish;
//       coronas, glow shells). Rendered in the transparent pass.
export class SphereHandle extends Node {
	constructor({ mode = 0, texLayer = -1, toneMapped = true } = {}) {
		super();
		this.kind = "sphere";
		this.position = new Vector3();
		this.scale = new UniformScale(1);
		this.rotation = {
			x: 0, y: 0, z: 0,
			set: (x, y, z) => { this.rotation.x = x; this.rotation.y = y; this.rotation.z = z; },
		};
		this.geometry = { parameters: { radius: 1 } };
		this.mode = mode;
		this.texLayer = texLayer;
		this.toneMapped = toneMapped;
		this.material = {
			color: new Color(0xffffff),
			emissive: new Color(0x000000),
			emissiveIntensity: 1,
			opacity: 1,
			transparent: mode === 2,
		};
	}
}

// Dashed (or solid) circle in the XZ plane at unit radius, scaled by
// `.scale`. Replaces the LineLoop + LineDashedMaterial halo rings.
export class RingHandle extends Node {
	constructor({ color = new Color(0xffffff), dashSize = 0.10, gapSize = 0.06, opacity = 0, segments = 96 } = {}) {
		super();
		this.kind = "ring";
		this.position = new Vector3();
		this.scale = new UniformScale(1);
		this.segments = segments;
		this.material = { color: color instanceof Color ? color.clone() : new Color(color), opacity, dashSize, gapSize };
	}
	traverse(fn) { fn(this); }
}

// Flat torus in the XZ plane (agent local-orbit ring). Unlit + transparent.
export class TorusHandle extends Node {
	constructor({ radius = 1, tube = 0.06, color = 0xffffff, opacity = 0.35 } = {}) {
		super();
		this.kind = "torus";
		this.position = new Vector3();
		this.radius = radius;
		this.tube = tube;
		this.material = { color: new Color(color), opacity };
	}
}

// Polyline (mode "strip") or independent segment list (mode "segments").
// `points` is a flat xyz Float32Array re-read every frame, so callers can
// mutate it in place exactly like a three BufferAttribute array.
export class LineHandle extends Node {
	constructor({ pointCount, mode = "strip", color = 0xffffff, opacity = 1 } = {}) {
		super();
		this.kind = "line";
		this.points = new Float32Array(pointCount * 3);
		this.mode = mode;
		this.material = { color: new Color(color), opacity };
	}
}

export class PointLightHandle extends Node {
	constructor(color = 0xffffff, intensity = 1, distance = 0, decay = 2) {
		super();
		this.kind = "pointlight";
		this.position = new Vector3();
		this.color = new Color(color);
		this.intensity = intensity;
		this.distance = distance;
		this.decay = decay;
	}
}

export class AmbientLightHandle extends Node {
	constructor(color = 0xffffff, intensity = 1) {
		super();
		this.kind = "ambient";
		this.color = new Color(color);
		this.intensity = intensity;
	}
}

// Static floor grid (GridHelper replacement): size×size, `divisions`
// cells, distinct center-line color, rendered as solid alpha lines.
export class GridHandle extends Node {
	constructor(size = 200, divisions = 100, colorCenter = 0x5eead4, colorGrid = 0x0d2b28, opacity = 0.5) {
		super();
		this.kind = "grid";
		this.position = new Vector3();
		this.size = size;
		this.divisions = divisions;
		this.colorCenter = new Color(colorCenter);
		this.colorGrid = new Color(colorGrid);
		this.material = { opacity };
	}
}

// Is this node (and every ancestor) visible?
export function nodeVisible(node) {
	let p = node;
	while (p) {
		if (p.visible === false) return false;
		p = p.parent;
	}
	return true;
}

// CPU ray/sphere picking over SphereHandles. Mirrors the shape of
// THREE.Raycaster.intersectObjects output: sorted [{ distance, object }].
export function intersectSpheres(ray, handles) {
	const hits = [];
	for (const h of handles) {
		if (h.kind !== "sphere") continue;
		const t = ray.intersectSphere(h.position, h.scale.value * h.geometry.parameters.radius);
		if (t != null) hits.push({ distance: t, object: h });
	}
	hits.sort((a, b) => a.distance - b.distance);
	return hits;
}
