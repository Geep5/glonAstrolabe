/**
 * Thin HTTP client for Graice's RivetKit actor gateway.
 *
 * Falls back gracefully when the daemon is offline. Used by the visualizer
 * to delegate expensive replay operations to glon rather than maintaining
 * a parallel implementation.
 */

const DAEMON_PORT = Number(process.env.GLON_DAEMON_PORT ?? 6420);
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;
export const DAEMON_URL = `${DAEMON_BASE}/dispatch`;

const RIVET_HEADERS = {
	"x-rivet-target": "actor",
	"x-rivet-encoding": "json",
} as const;

/** Call an actor action through the RivetKit HTTP gateway. */
async function actorAction<T = unknown>(
	actorId: string,
	actionName: string,
	args: unknown[],
): Promise<T | null> {
	try {
		const res = await fetch(`${DAEMON_BASE}/gateway/${encodeURIComponent(actorId)}/action/${encodeURIComponent(actionName)}`, {
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
		const res = await fetch(`${DAEMON_BASE}/actors?name=storeActor`);
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

/** Find a program actor id by its program object id. */
async function getProgramActorId(programId: string): Promise<string | null> {
	try {
		const res = await fetch(`${DAEMON_BASE}/actors?name=programActor`);
		if (!res.ok) return null;
		const data = (await res.json()) as { actors?: Array<{ actor_id: string; key: string }> } | null;
		for (const a of data?.actors ?? []) {
			if (a.key === programId) return a.actor_id;
		}
		return null;
	} catch {
		return null;
	}
}

/** Dispatch an action to a program via the RivetKit gateway.
 *  Returns null if the daemon is unreachable or the program is not found. */
export async function dispatchToDaemon(
	prefix: string,
	action: string,
	args: unknown[],
): Promise<unknown | null> {
	const progId = await getProgramIdForPrefix(prefix);
	if (!progId) return null;
	const actorId = await getProgramActorId(progId);
	if (!actorId) return null;

	const result = await actorAction<string>(actorId, "dispatch", [action, JSON.stringify(args)]);
	if (result === null) return null;
	try {
		return JSON.parse(result);
	} catch {
		return result;
	}
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

/** Ask an agent a message. Returns the string result or null on failure. */
export async function askAgent(agentId: string, message: string): Promise<string | null> {
	const result = await dispatchToDaemon("/agent", "ask", [agentId, message]);
	if (result === null) return null;
	if (typeof result === "string") return result;
	return JSON.stringify(result);
}

/** Trigger a recall (re-inject a compacted block). Returns the new block id or null. */
export async function recallBlock(agentId: string, blockId: string): Promise<string | null> {
	const result = await dispatchToDaemon("/agent", "recall", [agentId, blockId]);
	if (result === null) return null;
	if (typeof result === "string") return result;
	return JSON.stringify(result);
}

/** Trigger an inject (post a user_text describing an object). Returns the new block id or null. */
export async function injectObject(agentId: string, text: string): Promise<string | null> {
	const result = await dispatchToDaemon("/agent", "ask", [agentId, text]);
	if (result === null) return null;
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
