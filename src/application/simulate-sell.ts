import type { OpenPosition, PositionProposal } from '../core/models.ts';
import { immutableSnapshot } from '../core/snapshot.ts';
import type { PositionObservation } from '../positions/monitor.ts';
import { SimulationSellGuard, type SellGuardResult } from '../risk/sell-guard.ts';
import type { DryRunTradeRequest, DryRunTradeResult,
  DryRunTradingAdapter } from './trading-adapter.ts';
import { projectBalance, projectQuote } from './trading-facts.ts';

export type GuardedSellPreview = Readonly<{
  guard: SellGuardResult;
  preview: DryRunTradeResult | null;
  // Describes the preview attempt, not a persisted position/order state.
  exitReviewStatus: 'PREVIEWED' | 'BLOCKED' | 'UNRESOLVED';
}>;

export async function simulateGuardedSell(request: DryRunTradeRequest,
  position: OpenPosition, observation: PositionObservation,
  proposal: PositionProposal, instructionProgramIds: readonly string[],
  guard: SimulationSellGuard, adapter: DryRunTradingAdapter,
  clock: () => Date): Promise<GuardedSellPreview> {
  let reservedId: string | null = null;
  try {
    const stable = immutableSnapshot({ request, position, observation, proposal,
      instructionProgramIds });
    const trade = stable.request;
    const [quote, balance] = await Promise.all([
      adapter.quote(trade.quoteRequest).then(projectQuote),
      adapter.getBalance(trade.walletId, trade.quoteRequest.inputMint).then(projectBalance)
    ]);
    const facts = Object.freeze({ quote, balance });
    const verdict = guard.check({ ...stable, quote, balance }, clock());
    if (verdict.status !== 'SIMULATION_ALLOWED') return {
      guard: verdict, preview: null,
      exitReviewStatus: verdict.reasons.includes('QUOTE_MISSING_OR_STALE') ||
        verdict.reasons.includes('BALANCE_MISSING_OR_STALE') ? 'UNRESOLVED' : 'BLOCKED'
    };
    reservedId = trade.intent.id;
    const preview = adapter.sell(trade, facts);
    if (preview === null) {
      guard.cancelPreview(reservedId);
      return { guard: verdict, preview: null, exitReviewStatus: 'UNRESOLVED' };
    }
    if (!quote || preview.mode !== 'DRY_RUN' || preview.status !== 'SIMULATED' ||
        preview.intentId !== trade.intent.id || preview.side !== 'SELL' ||
        preview.venue !== trade.venue || preview.quoteRequestId !== quote.requestId ||
        preview.expectedOutputRaw !== quote.expectedOutputRaw ||
        preview.minOutputRaw !== quote.minOutputRaw ||
        preview.estimatedFeeRaw !== quote.estimatedFeeRaw ||
        !Array.isArray(preview.signatures) || preview.signatures.length !== 0) {
      throw new Error('Mismatched sell preview');
    }
    return { guard: verdict, preview: Object.freeze({
      mode: 'DRY_RUN', status: 'SIMULATED', intentId: trade.intent.id,
      side: 'SELL', venue: trade.venue, quoteRequestId: quote.requestId,
      expectedOutputRaw: quote.expectedOutputRaw, minOutputRaw: quote.minOutputRaw,
      estimatedFeeRaw: quote.estimatedFeeRaw, signatures: Object.freeze([]) as readonly []
    }),
      exitReviewStatus: 'PREVIEWED' };
  } catch {
    if (reservedId !== null) guard.cancelPreview(reservedId);
    return { guard: { status: 'BLOCKED', reasons: ['SIMULATION_ERROR'],
      intentId: null, policyVersion: 'unavailable' }, preview: null,
      exitReviewStatus: 'UNRESOLVED' };
  }
}
