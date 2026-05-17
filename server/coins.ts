/**
 * Stub — the actual coin-overview helper was removed when the /coin
 * program got stripped from glon. The cosmos reader still references
 * these types/functions for the (now never-taken) chain.coin.bucket
 * branch, so we leave thin stubs in place rather than surgically
 * removing every reference in reader.ts.
 *
 * Nothing actually uses any of this at runtime.
 */

import type { Block } from "glon/proto.js";

export const BUCKET_TYPE_KEY = "chain.coin.bucket";

export interface CoinState {
	tokenId?: string;
	balance?: string;
}

export function buildCoinState(_blocks: Block[] | undefined, _fields: Map<string, unknown> | undefined): CoinState | null {
	return null;
}
