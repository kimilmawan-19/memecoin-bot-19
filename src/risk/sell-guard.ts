import type { BalanceSnapshot, OpenPosition, PositionProposal, QuoteResult } from '../core/models.ts';
import { parsePositionProposal } from '../core/position-proposal.ts';
import { parseIsoTime, parseSignedBaseUnits } from '../core/invariants.ts';
import { parseMarketContext } from '../core/market.ts';
import { validSolanaAddress } from '../core/address.ts';
import type { DryRunTradeRequest } from '../application/trading-adapter.ts';
import type { PositionObservation } from '../positions/monitor.ts';
import { id, parseRiskPolicy, recent, units, type RiskPolicyConfig } from './policy.ts';

export type SellGuardInput = Readonly<{
  position: OpenPosition;
  observation: PositionObservation;
  proposal: PositionProposal;
  request: DryRunTradeRequest;
  quote: QuoteResult | null;
  balance: BalanceSnapshot | null;
  instructionProgramIds: readonly string[];
}>;

export type SellGuardResult = Readonly<{
  status: 'SIMULATION_ALLOWED' | 'BLOCKED';
  reasons: readonly string[];
  intentId: string | null;
  policyVersion: string;
}>;

// A sell guard has different limits from the BUY guard: a loss limit or kill
// switch must never suppress an exit. It grants simulation only, not authority.
export class SimulationSellGuard {
  private readonly policy: RiskPolicyConfig;
  private readonly usedIntentIds = new Set<string>();
  private readonly reservedPositions = new Map<string, {
    intentId: string; walletId: string; mint: string; amount: bigint;
  }>();

  constructor(policy: unknown) { this.policy = parseRiskPolicy(policy); }

  cancelPreview(intentId: string): void {
    for (const [positionId, reservation] of this.reservedPositions) {
      if (reservation.intentId === intentId) this.reservedPositions.delete(positionId);
    }
  }

  check(input: SellGuardInput, now: Date): SellGuardResult {
    const reasons: string[] = [];
    let safeIntentId: string | null = null;
    try { safeIntentId = id(input?.request?.intent?.id); } catch { /* No untrusted ID in result. */ }
    const result = (status: SellGuardResult['status']): SellGuardResult => Object.freeze({
      status, reasons: Object.freeze([...new Set(reasons)]), intentId: safeIntentId,
      policyVersion: this.policy.version
    });
    if (!Number.isFinite(now.getTime())) {
      reasons.push('INVALID_CLOCK');
      return result('BLOCKED');
    }
    try {
      const { position, observation, request, quote, balance } = input;
      const { intent, quoteRequest, walletId } = request;
      const proposal = parsePositionProposal(input.proposal);
      const market = parseMarketContext(observation.market);
      id(position.id);
      id(position.walletId);
      id(observation.snapshotId);
      id(observation.sourceId);
      id(intent.id);
      id(quoteRequest.id);
      if (!validSolanaAddress(position.mint) || position.mint === this.policy.quoteMint ||
          !Number.isSafeInteger(position.version) || position.version < 0 ||
          position.status !== 'OPEN' || position.exitIntentId !== null ||
          units(position.quantityRaw) === 0n ||
          units(position.costQuoteRaw) === 0n ||
          units(position.peakValueQuoteRaw) < units(position.costQuoteRaw)) {
        reasons.push('POSITION_INVALID');
      }
      parseSignedBaseUnits(position.realizedPnlQuoteRaw);
      if (observation.sourceKind !== 'FIXTURE' ||
          observation.positionId !== position.id ||
          observation.positionVersion !== position.version ||
          !recent(observation.observedAt, now, 60_000) ||
          market.windowTo !== observation.observedAt ||
          market.quoteMint !== this.policy.quoteMint ||
          observation.evidenceIds.length === 0 || observation.evidenceIds.length > 20 ||
          observation.evidenceIds.some((item) => !id(item))) {
        reasons.push('OBSERVATION_INVALID');
      }
      if (proposal.positionId !== position.id ||
          proposal.positionVersion !== position.version ||
          proposal.snapshotId !== observation.snapshotId ||
          proposal.action === 'HOLD' ||
          proposal.evidenceIds.length === 0 ||
          proposal.evidenceIds.some((item) => !observation.evidenceIds.includes(item)) ||
          !recent(proposal.createdAt, now, 60_000) ||
          Date.parse(proposal.expiresAt) <= now.getTime()) {
        reasons.push('PROPOSAL_INVALID');
      }
      if (this.usedIntentIds.has(intent.id)) reasons.push('DUPLICATE_INTENT');
      if (this.reservedPositions.has(position.id)) reasons.push('POSITION_EXIT_PENDING');
      if (this.usedIntentIds.size >= 10_000) reasons.push('SIMULATION_SESSION_FULL');
      const quantity = units(position.quantityRaw);
      const amount = units(intent.amountRaw);
      const reserved = [...this.reservedPositions.values()]
        .filter((item) => item.walletId === walletId && item.mint === position.mint)
        .reduce((sum, item) => sum + item.amount, 0n);
      const expectedAmount = proposal.action === 'EXIT' ? quantity :
        quantity * BigInt(proposal.reduceBps ?? 0) / 10_000n;
      if (intent.side !== 'SELL' || intent.mint !== position.mint ||
          intent.policyVersion !== this.policy.version ||
          walletId !== position.walletId ||
          Date.parse(parseIsoTime(intent.expiresAt)) <= now.getTime() ||
          Date.parse(intent.expiresAt) > now.getTime() + 60_000 ||
          amount === 0n || amount !== expectedAmount ||
          units(intent.minOutputRaw) === 0n ||
          units(intent.maxFeeRaw) > units(this.policy.maxFeeRaw) ||
          !Number.isInteger(intent.maxSlippageBps) || intent.maxSlippageBps < 0 ||
          intent.maxSlippageBps > this.policy.maxSlippageBps) reasons.push('INTENT_INVALID');
      if (quoteRequest.poolId !== market.poolId ||
          quoteRequest.inputMint !== position.mint ||
          quoteRequest.outputMint !== this.policy.quoteMint ||
          quoteRequest.amountInRaw !== intent.amountRaw ||
          quoteRequest.maxSlippageBps !== intent.maxSlippageBps ||
          !recent(quoteRequest.requestedAt, now, 15_000)) reasons.push('QUOTE_REQUEST_INVALID');
      if (!quote || quote.requestId !== quoteRequest.id ||
          !recent(quote.observedAt, now, 15_000) ||
          Date.parse(quote.observedAt) < Date.parse(quoteRequest.requestedAt) ||
          Date.parse(parseIsoTime(quote.expiresAt)) <= now.getTime() ||
          Date.parse(quote.expiresAt) > Date.parse(quote.observedAt) + 60_000 ||
          quote.evidenceIds.length === 0 || quote.evidenceIds.length > 20 ||
          quote.evidenceIds.some((item) => !id(item)) ||
          quote.priceImpactBps === null || !Number.isInteger(quote.priceImpactBps) ||
          quote.priceImpactBps < 0 || quote.priceImpactBps > this.policy.maxPriceImpactBps) {
        reasons.push('QUOTE_MISSING_OR_STALE');
      } else {
        const expected = units(quote.expectedOutputRaw);
        const minimum = units(quote.minOutputRaw);
        const floor = expected * BigInt(10_000 - intent.maxSlippageBps) / 10_000n;
        if (expected === 0n || minimum === 0n || minimum > expected ||
            minimum < floor || units(intent.minOutputRaw) < floor ||
            minimum < units(intent.minOutputRaw) ||
            units(quote.estimatedFeeRaw) > units(intent.maxFeeRaw)) reasons.push('QUOTE_LIMIT');
      }
      if (!balance || balance.walletId !== position.walletId ||
          balance.mint !== position.mint ||
          !recent(balance.observedAt, now, 30_000) ||
          !id(balance.sourceId) || units(balance.amountRaw) < amount + reserved) {
        reasons.push('BALANCE_MISSING_OR_STALE');
      }
      if (!Array.isArray(input.instructionProgramIds) ||
          input.instructionProgramIds.length === 0 || input.instructionProgramIds.length > 8 ||
          input.instructionProgramIds.some((program) =>
            typeof program !== 'string' || !this.policy.allowedProgramIds.includes(program))) {
        reasons.push('INSTRUCTION_PROGRAM_NOT_ALLOWED');
      }
      if (reasons.length) return result('BLOCKED');
      this.usedIntentIds.add(intent.id);
      this.reservedPositions.set(position.id, {
        intentId: intent.id, walletId, mint: position.mint, amount
      });
      return result('SIMULATION_ALLOWED');
    } catch {
      reasons.push('INVALID_GUARD_INPUT');
      return result('BLOCKED');
    }
  }
}
