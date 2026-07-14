/**
 * Minimal three.js-compatible math shim for the TypeGPU renderer.
 *
 * Implements exactly the subset of the three.js API that main.js /
 * cosmos.js / colors.js rely on: Vector3, Quaternion, Euler (YXZ),
 * Ray, Color, and a PerspectiveCamera whose project()/rayFromNDC()
 * are backed by wgpu-matrix (WebGPU [0,1] clip-z conventions).
 */

import { mat4 } from "wgpu-matrix";

// ── Vector3 ────────────────────────────────────────────────────────

export class Vector3 {
	constructor(x = 0, y = 0, z = 0) {
		this.x = x; this.y = y; this.z = z;
	}
	set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
	copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
	clone() { return new Vector3(this.x, this.y, this.z); }
	add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
	sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
	subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
	addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
	multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
	divideScalar(s) { return this.multiplyScalar(1 / s); }
	length() { return Math.sqrt(this.lengthSq()); }
	lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
	normalize() {
		const l = this.length();
		return l > 0 ? this.multiplyScalar(1 / l) : this;
	}
	distanceTo(v) {
		const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
	dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
	crossVectors(a, b) {
		const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
		this.x = ay * bz - az * by;
		this.y = az * bx - ax * bz;
		this.z = ax * by - ay * bx;
		return this;
	}
	lerpVectors(a, b, t) {
		this.x = a.x + (b.x - a.x) * t;
		this.y = a.y + (b.y - a.y) * t;
		this.z = a.z + (b.z - a.z) * t;
		return this;
	}
	applyQuaternion(q) {
		// v' = q * v * q^-1 (optimized form)
		const { x, y, z } = this;
		const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
		const ix = qw * x + qy * z - qz * y;
		const iy = qw * y + qz * x - qx * z;
		const iz = qw * z + qx * y - qy * x;
		const iw = -qx * x - qy * y - qz * z;
		this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
		this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
		this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
		return this;
	}
	// Project into NDC using the camera's view-projection matrix.
	// x/y land in [-1, 1]; z is [0, 1] (WebGPU) — or 2 when the point
	// is behind the camera, so existing `screen.z > 1` culls keep working.
	project(camera) {
		camera.updateMatrices();
		const m = camera.viewProj;
		const { x, y, z } = this;
		const w = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (w <= 0) { this.set(0, 0, 2); return this; }
		this.x = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
		this.y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
		this.z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
		return this;
	}
}

// ── Quaternion ─────────────────────────────────────────────────────

export class Quaternion {
	constructor(x = 0, y = 0, z = 0, w = 1) {
		this.x = x; this.y = y; this.z = z; this.w = w;
	}
	set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
	copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
	clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
	setFromAxisAngle(axis, angle) {
		const h = angle / 2, s = Math.sin(h);
		this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
		return this;
	}
	multiplyQuaternions(a, b) {
		const ax = a.x, ay = a.y, az = a.z, aw = a.w;
		const bx = b.x, by = b.y, bz = b.z, bw = b.w;
		this.x = ax * bw + aw * bx + ay * bz - az * by;
		this.y = ay * bw + aw * by + az * bx - ax * bz;
		this.z = az * bw + aw * bz + ax * by - ay * bx;
		this.w = aw * bw - ax * bx - ay * by - az * bz;
		return this;
	}
	setFromEuler(e) {
		// Supports the YXZ order used by the camera (and XYZ as fallback).
		const cx = Math.cos(e.x / 2), sx = Math.sin(e.x / 2);
		const cy = Math.cos(e.y / 2), sy = Math.sin(e.y / 2);
		const cz = Math.cos(e.z / 2), sz = Math.sin(e.z / 2);
		if ((e.order ?? "YXZ") === "YXZ") {
			this.x = sx * cy * cz + cx * sy * sz;
			this.y = cx * sy * cz - sx * cy * sz;
			this.z = cx * cy * sz - sx * sy * cz;
			this.w = cx * cy * cz + sx * sy * sz;
		} else { // XYZ
			this.x = sx * cy * cz + cx * sy * sz;
			this.y = cx * sy * cz - sx * cy * sz;
			this.z = cx * cy * sz + sx * sy * cz;
			this.w = cx * cy * cz - sx * sy * sz;
		}
		return this;
	}
	slerpQuaternions(a, b, t) {
		let bx = b.x, by = b.y, bz = b.z, bw = b.w;
		let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
		if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
		let s0, s1;
		if (cos > 0.9995) {
			s0 = 1 - t; s1 = t;
		} else {
			const omega = Math.acos(cos);
			const so = Math.sin(omega);
			s0 = Math.sin((1 - t) * omega) / so;
			s1 = Math.sin(t * omega) / so;
		}
		this.x = a.x * s0 + bx * s1;
		this.y = a.y * s0 + by * s1;
		this.z = a.z * s0 + bz * s1;
		this.w = a.w * s0 + bw * s1;
		return this;
	}
	// Rotation matrix (row-major 3x3) — shared by Euler + camera code.
	toMatrix3() {
		const { x, y, z, w } = this;
		return [
			1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
			2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
			2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
		];
	}
	setFromRotationMatrix3(m) {
		// m: row-major 9-element rotation matrix
		const trace = m[0] + m[4] + m[8];
		if (trace > 0) {
			const s = 0.5 / Math.sqrt(trace + 1);
			this.w = 0.25 / s;
			this.x = (m[7] - m[5]) * s;
			this.y = (m[2] - m[6]) * s;
			this.z = (m[3] - m[1]) * s;
		} else if (m[0] > m[4] && m[0] > m[8]) {
			const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
			this.w = (m[7] - m[5]) / s;
			this.x = 0.25 * s;
			this.y = (m[1] + m[3]) / s;
			this.z = (m[2] + m[6]) / s;
		} else if (m[4] > m[8]) {
			const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
			this.w = (m[2] - m[6]) / s;
			this.x = (m[1] + m[3]) / s;
			this.y = 0.25 * s;
			this.z = (m[5] + m[7]) / s;
		} else {
			const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
			this.w = (m[3] - m[1]) / s;
			this.x = (m[2] + m[6]) / s;
			this.y = (m[5] + m[7]) / s;
			this.z = 0.25 * s;
		}
		return this;
	}
}

// ── Euler (YXZ only — what the camera uses) ────────────────────────

export class Euler {
	constructor(x = 0, y = 0, z = 0, order = "YXZ") {
		this.x = x; this.y = y; this.z = z; this.order = order;
	}
	setFromQuaternion(q, order = this.order) {
		this.order = order;
		const m = q.toMatrix3();
		// Row-major: m[r*3+c]
		if (order === "YXZ") {
			this.x = Math.asin(-clamp(m[5], -1, 1));
			if (Math.abs(m[5]) < 0.9999999) {
				this.y = Math.atan2(m[2], m[8]);
				this.z = Math.atan2(m[3], m[4]);
			} else {
				this.y = Math.atan2(-m[6], m[0]);
				this.z = 0;
			}
		} else {
			throw new Error(`Euler order ${order} not supported`);
		}
		return this;
	}
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Ray ────────────────────────────────────────────────────────────

export class Ray {
	constructor(origin = new Vector3(), direction = new Vector3(0, 0, -1)) {
		this.origin = origin;
		this.direction = direction;
	}
	closestPointToPoint(point, out) {
		out.subVectors(point, this.origin);
		const t = out.dot(this.direction);
		if (t < 0) return out.copy(this.origin);
		return out.copy(this.direction).multiplyScalar(t).add(this.origin);
	}
	// Analytic ray/sphere intersection. Returns distance along the ray
	// or null when there is no hit in front of the origin.
	intersectSphere(center, radius) {
		const ox = center.x - this.origin.x;
		const oy = center.y - this.origin.y;
		const oz = center.z - this.origin.z;
		const tca = ox * this.direction.x + oy * this.direction.y + oz * this.direction.z;
		const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
		const r2 = radius * radius;
		if (d2 > r2) return null;
		const thc = Math.sqrt(r2 - d2);
		const t0 = tca - thc;
		const t1 = tca + thc;
		if (t1 < 0) return null;
		return t0 >= 0 ? t0 : t1;
	}
}

// ── Color ──────────────────────────────────────────────────────────

export class Color {
	constructor(value) {
		this.r = 1; this.g = 1; this.b = 1;
		if (value !== undefined) this.set(value);
	}
	set(value) {
		if (value instanceof Color) return this.copy(value);
		if (typeof value === "number") return this.setHex(value);
		if (typeof value === "string") {
			const m = /^#?([0-9a-f]{6})$/i.exec(value);
			if (m) return this.setHex(parseInt(m[1], 16));
			const m3 = /^#?([0-9a-f]{3})$/i.exec(value);
			if (m3) {
				const [r, g, b] = m3[1];
				return this.setHex(parseInt(r + r + g + g + b + b, 16));
			}
		}
		return this;
	}
	setHex(hex) {
		this.r = ((hex >> 16) & 255) / 255;
		this.g = ((hex >> 8) & 255) / 255;
		this.b = (hex & 255) / 255;
		return this;
	}
	setHSL(h, s, l) {
		h = ((h % 1) + 1) % 1;
		if (s === 0) { this.r = this.g = this.b = l; return this; }
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		this.r = hue2rgb(p, q, h + 1 / 3);
		this.g = hue2rgb(p, q, h);
		this.b = hue2rgb(p, q, h - 1 / 3);
		return this;
	}
	copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
	clone() { const c = new Color(); return c.copy(this); }
	getHexString() {
		const to = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0");
		return to(this.r) + to(this.g) + to(this.b);
	}
}

function hue2rgb(p, q, t) {
	if (t < 0) t += 1;
	if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
	return p;
}

// ── PerspectiveCamera ──────────────────────────────────────────────

const UP = new Vector3(0, 1, 0);

export class PerspectiveCamera {
	constructor(fov = 50, aspect = 1, near = 0.1, far = 2000) {
		this.fov = fov;
		this.aspect = aspect;
		this.near = near;
		this.far = far;
		this.position = new Vector3();
		this.quaternion = new Quaternion();
		this.rotation = { order: "YXZ" }; // order is the only field callers set
		this.proj = new Float32Array(16);
		this.view = new Float32Array(16);
		this.viewProj = new Float32Array(16);
		this.invViewProj = new Float32Array(16);
		this._dirtyProj = true;
		this.updateProjectionMatrix();
	}
	updateProjectionMatrix() {
		mat4.perspective((this.fov * Math.PI) / 180, this.aspect, this.near, this.far, this.proj);
		this._dirtyProj = false;
	}
	// Rebuilds view + viewProj from position/quaternion. Cheap enough to
	// call whenever a consumer needs matrices; no dirty-tracking on pose.
	updateMatrices() {
		if (this._dirtyProj) this.updateProjectionMatrix();
		const m = this.quaternion.toMatrix3(); // row-major world rotation
		const p = this.position;
		// view = R^T * T(-p); column-major output
		const v = this.view;
		v[0] = m[0]; v[1] = m[1]; v[2] = m[2]; v[3] = 0;
		v[4] = m[3]; v[5] = m[4]; v[6] = m[5]; v[7] = 0;
		v[8] = m[6]; v[9] = m[7]; v[10] = m[8]; v[11] = 0;
		// R^T rows are R columns; translation = -(R^T ⋅ p)
		v[12] = -(m[0] * p.x + m[3] * p.y + m[6] * p.z);
		v[13] = -(m[1] * p.x + m[4] * p.y + m[7] * p.z);
		v[14] = -(m[2] * p.x + m[5] * p.y + m[8] * p.z);
		v[15] = 1;
		mat4.multiply(this.proj, this.view, this.viewProj);
		mat4.invert(this.viewProj, this.invViewProj);
	}
	lookAt(x, y, z) {
		const t = x instanceof Vector3 ? x : new Vector3(x, y, z);
		// Camera looks down its local -Z. Build the world rotation whose
		// third basis column points from target to eye.
		const zAxis = new Vector3().subVectors(this.position, t);
		if (zAxis.lengthSq() < 1e-12) zAxis.set(0, 0, 1);
		zAxis.normalize();
		const xAxis = new Vector3().crossVectors(UP, zAxis);
		if (xAxis.lengthSq() < 1e-10) xAxis.set(1, 0, 0);
		xAxis.normalize();
		const yAxis = new Vector3().crossVectors(zAxis, xAxis);
		this.quaternion.setFromRotationMatrix3([
			xAxis.x, yAxis.x, zAxis.x,
			xAxis.y, yAxis.y, zAxis.y,
			xAxis.z, yAxis.z, zAxis.z,
		]);
		return this;
	}
	getWorldDirection(out) {
		const m = this.quaternion.toMatrix3();
		// forward = R ⋅ (0,0,-1)
		return out.set(-m[2], -m[5], -m[8]).normalize();
	}
	// Ray through NDC (x, y in [-1, 1], y up) — replaces Raycaster.setFromCamera.
	rayFromNDC(x, y, out = new Ray()) {
		this.updateMatrices();
		const inv = this.invViewProj;
		// Unproject a point on the far side of the frustum (z=1 in [0,1] clip).
		const px = inv[0] * x + inv[4] * y + inv[8] + inv[12];
		const py = inv[1] * x + inv[5] * y + inv[9] + inv[13];
		const pz = inv[2] * x + inv[6] * y + inv[10] + inv[14];
		const pw = inv[3] * x + inv[7] * y + inv[11] + inv[15];
		out.origin.copy(this.position);
		out.direction.set(px / pw, py / pw, pz / pw).sub(this.position).normalize();
		return out;
	}
}
