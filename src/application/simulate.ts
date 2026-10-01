import type { ScreenerProposal, TokenCandidate, TokenIntelligence } from '../core/models.ts';
import { immutableSnapshot } from '../core/snapshot.ts';
import type { DryRunTradeRequest, DryRunTradeResult,
  DryRunTradingAdapter } from './trading-adapter.ts';
import { SimulationExecutionGuard, type SimulationGuardResult } from '../risk/guard.ts';
import type { PortfolioSnapshot } from '../risk/portfolio.ts';
import type { TokenRiskFacts } from '../risk/token.ts';

export type GuardedPreview = Readonly<{
  guard: SimulationGuardResult;
  preview: DryRunTradeResult | null;
}>;

// Fixture-only: one immutable quote is checked and then synchronously previewed.
// Successful previews retain their reservation for this simulation session.
export async function simulateGuardedBuy(request: DryRunTradeRequest,
  candidate: TokenCandidate, intelligence: TokenIntelligence,
  tokenFacts: TokenRiskFacts | null, portfolio: PortfolioSnapshot | null,
  proposal: ScreenerProposal, instructionProgramIds: readonly string[],
  guard: SimulationExecutionGuard, adapter: DryRunTradingAdapter,
  clock: () => Date): Promise<GuardedPreview> {
  let reservedId: string | null = null;
  try {
    const stable = immutableSnapshot({ request, candidate, intelligence, tokenFacts,
      portfolio, proposal, instructionProgramIds });
    const trade = stable.request;
    const [quote, balance] = await Promise.all([
      adapter.quote(trade.quoteRequest).then(immutableSnapshot),
      adapter.getBalance(trade.walletId, trade.quoteRequest.inputMint).then(immutableSnapshot)
    ]);
    const facts = Object.freeze({ quote, balance });
    const verdict = guard.check({
      ...stable, intent: trade.intent, quoteRequest: trade.quoteRequest,
      ...facts, walletId: trade.walletId
    }, clock());
    if (verdict.status !== 'SIMULATION_ALLOWED') return { guard: verdict, preview: null };
    reservedId = trade.intent.id;
    const preview = adapter.buy(trade, facts);
    if (preview === null) {
      guard.cancelPreview(reservedId);
      return { guard: verdict, preview: null };
    }
    // An adapter cannot report a different quote or request as the guarded preview.
    if (!quote || preview.mode !== 'DRY_RUN' || preview.status !== 'SIMULATED' ||
        preview.intentId !== trade.intent.id || preview.side !== 'BUY' ||
        preview.venue !== trade.venue || preview.quoteRequestId !== quote.requestId ||
        preview.expectedOutputRaw !== quote.expectedOutputRaw ||
        preview.minOutputRaw !== quote.minOutputRaw || preview.estimatedFeeRaw !== quote.estimatedFeeRaw ||
        !Array.isArray(preview.signatures) || preview.signatures.length !== 0) {
      throw new Error('Mismatched preview');
    }
    return { guard: verdict, preview: immutableSnapshot(preview) };
  } catch {
    if (reservedId !== null) guard.cancelPreview(reservedId);
    return {
      guard: { status: 'BLOCKED', reasons: ['SIMULATION_ERROR'],
        intentId: null, policyVersion: 'unavailable' },
      preview: null
    };
  }
}
