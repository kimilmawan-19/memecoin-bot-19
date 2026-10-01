import type {
  BalanceSnapshot, ExecutionIntent, QuoteRequest, QuoteResult
} from '../core/models.ts';

export type TradeVenue = 'pumpfun' | 'pumpswap' | 'bonk' |
  'raydium-cpmm' | 'raydium-amm-v4' | 'meteora-damm-v2';

export type DryRunTradeRequest = Readonly<{
  intent: ExecutionIntent;
  quoteRequest: QuoteRequest;
  venue: TradeVenue;
  walletId: string;
}>;

export type DryRunFacts = Readonly<{
  quote: QuoteResult | null;
  balance: BalanceSnapshot | null;
}>;

// A preview is never an ExecutionResult and contains no transaction signature.
export type DryRunTradeResult = Readonly<{
  mode: 'DRY_RUN';
  status: 'SIMULATED';
  intentId: string;
  side: 'BUY' | 'SELL';
  venue: TradeVenue;
  quoteRequestId: string;
  expectedOutputRaw: string;
  minOutputRaw: string;
  estimatedFeeRaw: string;
  signatures: readonly [];
}>;

// buy/sell are synchronous previews over supplied facts. They must not refetch.
// Phase 3 only. A future live port must accept a runtime authorization from
// the deterministic guard; it must not reuse DryRunTradeRequest as authority.
export interface DryRunTradingAdapter {
  quote(request: QuoteRequest): Promise<QuoteResult | null>;
  getBalance(walletId: string, mint: string): Promise<BalanceSnapshot | null>;
  buy(request: DryRunTradeRequest, facts: DryRunFacts): DryRunTradeResult | null;
  sell(request: DryRunTradeRequest, facts: DryRunFacts): DryRunTradeResult | null;
}
