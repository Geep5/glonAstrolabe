/**
 * glonAstrolabe — HTTP server for the Figgies UI.
 *
 * Proxies the browser's REST calls to the Figgies daemon's /dispatch
 * endpoint and serves the static frontend from public/. Wallet info is
 * read directly from ~/.figgies/wallet.json so the UI knows "who am I."
 *
 * The chat-related routes (/api/network, /api/peer-chat, /api/agents)
 * are scaffold for the future — they currently return empty data so the
 * UI panels can render without errors. They'll come alive when the
 * Figgies daemon grows /directory, /peer-chat, and /agent programs.
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dispatchToDaemon } from "./daemon-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const FIGGIES_ROOT = process.env.FIGGIES_ROOT ?? join(homedir(), ".figgies");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use((req, _res, next) => {
	console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
	next();
});

// ── Auction house (live, dispatched to Figgies daemon) ────────────

app.get("/api/auction/status", async (_req, res) => {
	try {
		const status = await dispatchToDaemon("/auction", "status", []);
		res.json({ ok: true, status });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.get("/api/auctions", async (_req, res) => {
	try {
		const list = await dispatchToDaemon("/auction", "list", []);
		res.json({ ok: true, auctions: list ?? [] });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.get("/api/auctions/:id/bids", async (req, res) => {
	try {
		const bids = await dispatchToDaemon("/auction", "getBids", [req.params.id]);
		res.json({ ok: true, bids: bids ?? [] });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/auctions/post", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/auction", "post", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/auctions/bid", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/auction", "bid", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/auctions/settle", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/auction", "settle", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/auctions/cancel", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/auction", "cancel", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

// ── Coins / Figgies tokens ────────────────────────────────────────

app.get("/api/coins", async (_req, res) => {
	try {
		const tokens = await dispatchToDaemon("/coin", "list", []);
		res.json({ ok: true, tokens: tokens ?? [] });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.get("/api/coins/:id/holders", async (req, res) => {
	try {
		const holders = await dispatchToDaemon("/coin", "holders", [{ tokenId: req.params.id }]);
		res.json({ ok: true, holders: holders ?? [] });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

// ── Family (parents, kids, mint, transfer) ────────────────────────

app.get("/api/family", async (_req, res) => {
	try {
		const users = await dispatchToDaemon("/family", "list", []);
		res.json({ ok: true, users: users ?? [] });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.get("/api/family/me", async (_req, res) => {
	try {
		const me = await dispatchToDaemon("/family", "me", []);
		res.json({ ok: true, ...((me as any) ?? {}) });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/family/register", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/family", "register", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/family/mint", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/family", "mint", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/family/transfer", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/family", "transfer", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

// ── Local wallet (which user this device represents) ──────────────

app.get("/api/wallet", (_req, res) => {
	const path = join(FIGGIES_ROOT, "wallet.json");
	if (!existsSync(path)) return res.json({ pubkeys: [] });
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const keys = raw?.keys ?? {};
		const pubkeys = Object.values(keys)
			.map((entry: any) => entry?.pubkey)
			.filter((k: any) => typeof k === "string");
		res.json({ pubkeys });
	} catch {
		res.json({ pubkeys: [] });
	}
});

// ── Future chat infrastructure (stubs) ─────────────────────────────
// These routes back the network, peer-chat, and agent-chat UI panels.
// They return empty results until the Figgies daemon grows /directory,
// /peer-chat, and /agent programs. The shape matches what the panels
// expect, so they render gracefully without backend support.

app.get("/api/network/status", (_req, res) => {
	res.json({ ok: true, status: { hyperswarm_pubkey: "", peers_connected: 0, topics_joined: 0, queue_depth: 0, pending_requests: 0, discovered_count: 0, self: { identity_pubkey: "", hyperswarm_pubkey: "", agent_name: "", last_announce_at: 0, is_announcing: false, announce_interval_s: 0 } } });
});

app.get("/api/network/peers", (_req, res) => {
	res.json({ ok: true, peers: [] });
});

app.get("/api/network/requests", (_req, res) => {
	res.json({ ok: true, requests: [] });
});

app.post("/api/network/peer", (_req, res) => {
	res.status(501).json({ ok: false, error: "peering not implemented yet" });
});

app.post("/api/network/requests/:id/accept", (_req, res) => {
	res.status(501).json({ ok: false, error: "peering not implemented yet" });
});

app.post("/api/network/requests/:id/decline", (_req, res) => {
	res.status(501).json({ ok: false, error: "peering not implemented yet" });
});

app.post("/api/network/announce", (_req, res) => {
	res.status(501).json({ ok: false, error: "peering not implemented yet" });
});

app.get("/api/peer-chat/conversations", (_req, res) => {
	res.json({ ok: true, conversations: [] });
});

app.get("/api/peer-chat/messages", (_req, res) => {
	res.json({ ok: true, messages: [] });
});

app.post("/api/peer-chat/send", (_req, res) => {
	res.status(501).json({ ok: false, error: "peer chat not implemented yet" });
});

app.post("/api/peer-chat/mark-read", (_req, res) => {
	res.json({ ok: true });
});

app.get("/api/agents", (_req, res) => {
	res.json({ agents: [] });
});

app.get("/api/agents/:id/conversation", (_req, res) => {
	res.status(404).json({ error: "agents not implemented yet" });
});

app.get("/api/agents/:id/context", (_req, res) => {
	res.status(404).json({ error: "agents not implemented yet" });
});

app.post("/api/agents/:id/chat", (_req, res) => {
	res.status(501).json({ ok: false, error: "agents not implemented yet" });
});

// ── Static frontend ───────────────────────────────────────────────

app.use(express.static(join(ROOT, "public")));

// ── Bootstrap ─────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

app.listen(PORT, HOST, () => {
	console.log(`glonAstrolabe → http://${HOST}:${PORT}`);
	console.log(`  wallet source: ${FIGGIES_ROOT}/wallet.json`);
	console.log(`  daemon dispatch: ${process.env.GLON_DISPATCH_PORT ?? 6430}`);
});
