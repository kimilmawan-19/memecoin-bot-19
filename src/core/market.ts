import type { MarketContext } from './models.ts';
import { validSolanaAddress } from './address.ts';
import { parseIsoTime } from './invariants.ts';

export function parseMarketContext(value: unknown): MarketContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Missing market context');
  }
  const raw = value as Record<string, unknown>;
  const keys = ['poolId', 'quoteMint', 'quoteDecimals', 'windowFrom', 'windowTo'];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      !validSolanaAddress(raw.poolId) || !validSolanaAddress(raw.quoteMint) ||
      raw.poolId === raw.quoteMint || !Number.isInteger(raw.quoteDecimals) ||
      (raw.quoteDecimals as number) < 0 || (raw.quoteDecimals as number) > 18) {
    throw new Error('Invalid market context');
  }
  const windowFrom = parseIsoTime(raw.windowFrom);
  const windowTo = parseIsoTime(raw.windowTo);
  const duration = Date.parse(windowTo) - Date.parse(windowFrom);
  if (duration < 60_000 || duration > 900_000) throw new Error('Invalid market window');
  return Object.freeze({ poolId: raw.poolId, quoteMint: raw.quoteMint,
    quoteDecimals: raw.quoteDecimals as number, windowFrom, windowTo });
}

export function sameMarketContext(a: MarketContext, b: MarketContext): boolean {
  return a.poolId === b.poolId && a.quoteMint === b.quoteMint && a.quoteDecimals === b.quoteDecimals &&
    a.windowFrom === b.windowFrom && a.windowTo === b.windowTo;
}
