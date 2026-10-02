import type { BalanceSnapshot, QuoteResult } from '../core/models.ts';
import { immutableSnapshot } from '../core/snapshot.ts';

// Drop provider-specific fields before the guard and preview adapter receive
// a quote or balance. The guard still validates the projected values.
export function projectQuote(quote: QuoteResult | null): QuoteResult | null {
  if (quote !== null && !Array.isArray(quote.evidenceIds)) {
    throw new Error('Invalid quote evidence');
  }
  return quote === null ? null : immutableSnapshot({
      requestId: quote.requestId, expectedOutputRaw: quote.expectedOutputRaw,
      minOutputRaw: quote.minOutputRaw, estimatedFeeRaw: quote.estimatedFeeRaw,
      priceImpactBps: quote.priceImpactBps, observedAt: quote.observedAt,
      expiresAt: quote.expiresAt, evidenceIds: [...quote.evidenceIds]
  });
}

export function projectBalance(balance: BalanceSnapshot | null): BalanceSnapshot | null {
  return balance === null ? null : immutableSnapshot({
      walletId: balance.walletId, mint: balance.mint,
      amountRaw: balance.amountRaw, observedAt: balance.observedAt,
      sourceId: balance.sourceId
  });
}
