/**
 * Bundles the TypeGPU renderer (gpu-src/) into a single browser ES
 * module at public/js/gpu/renderer.js.
 *
 * The rest of the frontend stays buildless; only this module needs a
 * build step because TypeGPU's `'use gpu'` shader functions require
 * the unplugin-typegpu transform. Run via `npm run build:gpu` (also
 * runs automatically before `npm run dev` / `npm start`).
 */

import { build } from "esbuild";
import typegpuPlugin from "unplugin-typegpu/esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
	entryPoints: [join(ROOT, "gpu-src", "renderer.js")],
	outfile: join(ROOT, "public", "js", "gpu", "renderer.js"),
	bundle: true,
	format: "esm",
	target: "es2022",
	sourcemap: true,
	minify: false,
	plugins: [typegpuPlugin()],
	logLevel: "info",
});
