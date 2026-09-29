import type { ScreenerProposal, TokenCandidate, TokenIntelligence } from '../core/models.ts';
import type { DryRunTradeRequest, DryRunTradeResult,
  DryRunTradingAdapter } from './trading-adapter.ts';
import { SimulationExecutionGuard, type SimulationGuardResult } from '../risk/guard.ts';
import type { PortfolioSnapshot } from '../risk/portfolio.ts';
import type { TokenRiskFacts } from '../risk/token.ts';

export type GuardedPreview = Readonly<{
  guard: SimulationGuardResult;
  preview: DryRunTradeResult | null;
}>;

// The only Phase 6 application path is fixture-backed dry-run. No signer,
// transaction payload, or live authorization is created here.
export async function simulateGuardedBuy(request: DryRunTradeRequest,
  candidate: TokenCandidate, intelligence: TokenIntelligence,
  tokenFacts: TokenRiskFacts | null, portfolio: PortfolioSnapshot | null,
  proposal: ScreenerProposal, instructionProgramIds: readonly string[],
  guard: SimulationExecutionGuard, adapter: DryRunTradingAdapter,
  now: Date): Promise<GuardedPreview> {
  try {
    const [quote, balance] = await Promise.all([
      adapter.quote(request.quoteRequest),
      adapter.getBalance(request.walletId, request.quoteRequest.inputMint)
    ]);
    const verdict = guard.check({
      candidate, intelligence, tokenFacts, portfolio, proposal,
      intent: request.intent, quoteRequest: request.quoteRequest,
      quote, balance, walletId: request.walletId, instructionProgramIds
    }, now);
    if (verdict.status !== 'SIMULATION_ALLOWED') return { guard: verdict, preview: null };
    return { guard: verdict, preview: await adapter.buy(request) };
  } catch {
    return {
      guard: { status: 'BLOCKED', reasons: ['SIMULATION_ERROR'],
        intentId: null, policyVersion: 'unavailable' },
      preview: null
    };
  }
}
