/**
 * Thin HTTP client for the Figgies daemon's /dispatch endpoint.
 *
 * The daemon listens on FIGGIES_PORT (default 6430). Astrolabe calls into
 * it for everything in the auction house, coin balances, and family ops.
 */

const DISPATCH_PORT = Number(process.env.GLON_DISPATCH_PORT ?? process.env.FIGGIES_PORT ?? 6430);
const DISPATCH_BASE = `http://127.0.0.1:${DISPATCH_PORT}`;

export const DAEMON_URL = `${DISPATCH_BASE}/dispatch`;

/** Dispatch an action to a program through the daemon's HTTP /dispatch
 *  endpoint. Throws on transport failure and on `{ok:false}` responses
 *  so route handlers' `.catch` returns a clean 503. */
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
		throw new Error(`figgies daemon unreachable at ${DISPATCH_BASE}: ${err?.message ?? String(err)}`);
	}
	if (!res.ok) {
		let body: any = null;
		try { body = await res.json(); } catch { /* non-json */ }
		const msg = body?.error ?? `HTTP ${res.status} ${res.statusText}`;
		throw new Error(`daemon dispatch ${prefix} ${action}: ${msg}`);
	}
	const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
	if (body?.ok === false) {
		throw new Error(`daemon dispatch ${prefix} ${action}: ${body.error ?? "unknown error"}`);
	}
	return body.result ?? null;
}
