/**
 * Thin HTTP client for Graice's RivetKit actor gateway.
 *
 * Falls back gracefully when the daemon is offline. Used by the visualizer
 * to delegate expensive replay operations to glon rather than maintaining
 * a parallel implementation.
 */

// Two ports involved:
//   - HOST_PORT (default 6420) — the RivetKit actor host (started by
//     `npm run dev` in glon). storeActor lives here; we still use it for
//     read-only program discovery.
//   - DISPATCH_PORT (default 6430) — the daemon's local HTTP dispatch
//     endpoint (scripts/daemon.ts). Program actor instances run inside
//     the daemon process and ARE addressable via this endpoint; they are
//     NOT registered as RivetKit programActor instances, so going through
//     the host gateway for actor dispatch silently returns null.
const HOST_PORT = Number(process.env.GLON_HOST_PORT ?? process.env.GLON_DAEMON_PORT ?? 6420);
const DISPATCH_PORT = Number(process.env.GLON_DISPATCH_PORT ?? 6430);
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const DISPATCH_BASE = `http://127.0.0.1:${DISPATCH_PORT}`;
// Exported for compatibility — historically /dispatch on the same port as
// the actor gateway. Now points at the daemon's HTTP endpoint.
export const DAEMON_URL = `${DISPATCH_BASE}/dispatch`;

const RIVET_HEADERS = {
	"x-rivet-target": "actor",
	"x-rivet-encoding": "json",
} as const;

	/** Call an actor action through the RivetKit HTTP gateway on the host.
	 *  Used for read-only storeActor lookups in getPrograms(). */
	async function actorAction<T = unknown>(
	actorId: string,
	actionName: string,
	args: unknown[],
): Promise<T | null> {
	try {
		const res = await fetch(`${HOST_BASE}/gateway/${encodeURIComponent(actorId)}/action/${encodeURIComponent(actionName)}`, {
			method: "POST",
			headers: {
				...RIVET_HEADERS,
				"x-rivet-actor": actorId,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ args }),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { output?: T } | null;
		return data?.output ?? null;
	} catch {
		return null;
	}
}

/** Find the store actor id (cached for the process lifetime). */
let storeActorId: string | null = null;
async function getStoreActorId(): Promise<string | null> {
	if (storeActorId) return storeActorId;
	try {
		const res = await fetch(`${HOST_BASE}/actors?name=storeActor`);
		if (!res.ok) return null;
		const data = (await res.json()) as { actors?: Array<{ actor_id: string }> } | null;
		const id = data?.actors?.[0]?.actor_id ?? null;
		if (id) storeActorId = id;
		return id;
	} catch {
		return null;
	}
}

/** Map of program prefix → program object id (populated on first use). */
let programPrefixCache: Map<string, string> | null = null;

	async function refreshProgramPrefixes(): Promise<Map<string, string>> {
	const cache = new Map<string, string>();
	const storeId = await getStoreActorId();
	if (!storeId) return cache;

	const list = await actorAction<{ id: string; typeKey: string }[]>(storeId, "list", ["program"]);
	if (!list) return cache;

	for (const ref of list) {
		const obj = await actorAction<{
			id: string;
			fields?: Record<string, { stringValue?: string }>;
		} | null>(storeId, "get", [ref.id]);
		const prefix = obj?.fields?.prefix?.stringValue;
		if (prefix) cache.set(prefix, ref.id);
	}
	programPrefixCache = cache;
	return cache;
}

async function getProgramIdForPrefix(prefix: string): Promise<string | null> {
	if (!programPrefixCache) {
		await refreshProgramPrefixes();
	}
	return programPrefixCache?.get(prefix) ?? null;
}

/** Dispatch an action to a program through the daemon's HTTP /dispatch
 *  endpoint. The daemon runs program actor instances locally (they are
 *  NOT registered with the host's RivetKit programActor pool), so this
 *  path is the only reliable way to reach them.
 *
 *  Throws on transport failure (daemon unreachable) and on `{ok:false}`
 *  responses from the daemon so callers' `.catch` handlers fire instead
 *  of silently dropping replies. */
export async function dispatchToDaemon(
	prefix: string,
	action: string,
	args: unknown[],
): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(`${DISPATCH_BASE}/dispatch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prefix, action, args }),
		});
	} catch (err: any) {
		throw new Error(`glon daemon unreachable at ${DISPATCH_BASE}: ${err?.message ?? String(err)}`);
	}
	if (!res.ok) {
		// Try to extract the daemon's structured error.
		let body: any = null;
		try { body = await res.json(); } catch { /* non-json */ }
		const msg = body?.error ?? `HTTP ${res.status} ${res.statusText}`;
		throw new Error(`daemon dispatch ${prefix} ${action}: ${msg}`);
	}
	const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
	if (body?.ok === false) {
		throw new Error(`daemon dispatch ${prefix} ${action}: ${body.error ?? "unknown error"}`);
	}
	return body?.result;
}

/** Fetch the list of loaded programs from the daemon. Returns null if offline. */
export async function getPrograms(): Promise<
	{ id: string; prefix: string; name: string; typedActions?: Record<string, { description?: string; inputSchema?: Record<string, unknown> }>; tickMs?: number }[] | null
> {
	const prefixes = await refreshProgramPrefixes();
	if (prefixes.size === 0) return null;

	const storeId = await getStoreActorId();
	if (!storeId) return null;

	const programs: Awaited<ReturnType<typeof getPrograms>> = [];
	for (const [prefix, progId] of prefixes) {
		const obj = await actorAction<{
			id: string;
			fields?: Record<string, { stringValue?: string; mapValue?: { entries?: Record<string, { stringValue?: string }> } }>;
		} | null>(storeId, "get", [progId]);
		if (!obj) continue;
		const name = obj.fields?.name?.stringValue ?? prefix;
		programs.push({ id: progId, prefix, name });
	}
	return programs.length > 0 ? programs : null;
}

/** Ask an agent a message. Throws on daemon error so the caller's `.catch`
 *  can surface the failure (network down, missing credentials, agent
 *  rejected the prompt, etc.). */
export async function askAgent(agentId: string, message: string): Promise<string> {
	const result = await dispatchToDaemon("/agent", "ask", [agentId, message]);
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	return JSON.stringify(result);
}

/** Trigger a recall (re-inject a compacted block). Throws on daemon error. */
export async function recallBlock(agentId: string, blockId: string): Promise<string> {
	const result = await dispatchToDaemon("/agent", "recall", [agentId, blockId]);
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	return JSON.stringify(result);
}

/** Trigger an inject (post a user_text describing an object). Throws on daemon error. */
export async function injectObject(agentId: string, text: string): Promise<string> {
	const result = await dispatchToDaemon("/agent", "ask", [agentId, text]);
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	return JSON.stringify(result);
}

// ── Tasks helpers ─────────────────────────────────────────────────

const DAEMON_TASKS_URL = DAEMON_URL.replace("/dispatch", "/tasks");
export { DAEMON_TASKS_URL };

export interface DaemonTask {
	id: string;
	name: string;
	enabled: boolean;
	intervalMs?: number;
	lastRun?: number;
	nextRun?: number;
	lastError?: string;
}

export async function getDaemonTasks(): Promise<DaemonTask[] | null> {
	try {
		const res = await fetch(DAEMON_TASKS_URL);
		if (!res.ok) return null;
		const data = (await res.json()) as { ok: boolean; tasks: DaemonTask[] };
		return data.ok ? data.tasks : null;
	} catch {
		return null;
	}
}
