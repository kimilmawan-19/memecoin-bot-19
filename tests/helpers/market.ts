import type { MarketContext } from '../../src/core/models.ts';

export const POOL = '6qFN7wzuR4W91gsbRQ3C7kgyqCTjAVfHn9dgdMYmRaYR';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2q1NzybapC8G4wEGGkZwyTDt1v';

export function marketAt(at: string, quoteMint = WSOL, quoteDecimals = 9): MarketContext {
  return { poolId: POOL, quoteMint, quoteDecimals,
    windowFrom: new Date(Date.parse(at) - 300_000).toISOString(), windowTo: at };
}
