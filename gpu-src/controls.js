/**
 * OrbitLite — the sliver of three.js OrbitControls this app still used.
 *
 * main.js drives rotation/pan itself (head-turn look + WASD); the only
 * things OrbitControls contributed were wheel-dolly toward `.target`
 * with damping, min/max distance clamping, and the `start` event that
 * cancels follow mode. The private `_spherical` resync hack from the
 * original is replaced by an explicit `syncFromCamera()`.
 */

import { Vector3 } from "./math.js";

export class OrbitLite {
	constructor(camera, domElement) {
		this.camera = camera;
		this.domElement = domElement;
		this.target = new Vector3();
		this.enabled = true;
		this.enableDamping = false;
		this.dampingFactor = 0.08;
		this.enableRotate = false; // rotation is app-driven; kept for API parity
		this.minDistance = 0;
		this.maxDistance = Infinity;
		this._listeners = { start: [] };
		this._pendingScale = 1; // multiplicative dolly not yet applied

		this._onWheel = (e) => {
			if (!this.enabled) return;
			e.preventDefault();
			this._emit("start");
			// ~0.95x per wheel notch, matching OrbitControls' zoom feel.
			const notches = e.deltaY / 100;
			this._pendingScale *= Math.pow(0.95, -notches);
		};
		domElement.addEventListener("wheel", this._onWheel, { passive: false });
	}

	addEventListener(type, cb) {
		(this._listeners[type] ??= []).push(cb);
	}
	_emit(type) {
		for (const cb of this._listeners[type] ?? []) cb();
	}

	// Forget any in-flight dolly; call after the camera was moved
	// programmatically (tween end, mouselook release).
	syncFromCamera() {
		this._pendingScale = 1;
	}

	update() {
		if (!this.enabled) return;
		if (this._pendingScale === 1) return;
		const cam = this.camera;
		const dx = cam.position.x - this.target.x;
		const dy = cam.position.y - this.target.y;
		const dz = cam.position.z - this.target.z;
		const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (dist < 1e-6) { this._pendingScale = 1; return; }

		// With damping, apply a fraction of the pending scale per frame.
		const k = this.enableDamping ? Math.min(1, this.dampingFactor * 2.5) : 1;
		const step = Math.pow(this._pendingScale, k);
		let next = dist / step;
		next = Math.max(this.minDistance, Math.min(this.maxDistance, next));
		const applied = dist / next;             // scale actually applied
		this._pendingScale /= applied;
		if (Math.abs(Math.log(this._pendingScale)) < 0.001 || k === 1) this._pendingScale = 1;

		const f = next / dist;
		cam.position.set(this.target.x + dx * f, this.target.y + dy * f, this.target.z + dz * f);
	}

	dispose() {
		this.domElement.removeEventListener("wheel", this._onWheel);
	}
}
