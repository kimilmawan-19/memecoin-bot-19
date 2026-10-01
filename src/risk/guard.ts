import type { BalanceSnapshot, ExecutionIntent, QuoteRequest, QuoteResult,
  ScreenerProposal, TokenCandidate, TokenIntelligence } from '../core/models.ts';
import { parseScreenerProposal } from '../core/proposal.ts';
import { parseIsoTime } from '../core/invariants.ts';
import { validSolanaAddress } from '../core/address.ts';
import { assessPortfolioRisk, type PortfolioSnapshot } from './portfolio.ts';
import { id, parseRiskPolicy, recent, units, type RiskPolicyConfig } from './policy.ts';
import { assessTokenRisk, type TokenRiskFacts } from './token.ts';

export type SimulationGuardInput = Readonly<{
  candidate: TokenCandidate;
  intelligence: TokenIntelligence;
  tokenFacts: TokenRiskFacts | null;
  portfolio: PortfolioSnapshot | null;
  proposal: ScreenerProposal;
  intent: ExecutionIntent;
  quoteRequest: QuoteRequest;
  quote: QuoteResult | null;
  balance: BalanceSnapshot | null;
  walletId: string;
  // Only a fixture manifest. This is NOT validation of serialized Solana instructions.
  instructionProgramIds: readonly string[];
}>;

export type SimulationGuardResult = Readonly<{
  status: 'SIMULATION_ALLOWED' | 'BLOCKED';
  reasons: readonly string[];
  intentId: string | null;
  policyVersion: string;
}>;

// The guard emits no live authorization and has no adapter/signer reference.
// Its in-memory idempotency set applies only inside this one dry-run process.
export class SimulationExecutionGuard {
  private readonly usedIntentIds = new Set<string>();
  private readonly reservations = new Map<string, {
    walletId: string; mint: string; amount: bigint;
  }>();
  private readonly policy: RiskPolicyConfig;

  constructor(policy: unknown) {
    this.policy = parseRiskPolicy(policy);
  }

  // Only failed/null previews release capacity. The ID remains consumed.
  // Successful previews stay reserved for this guard's simulation session.
  cancelPreview(intentId: string): void {
    this.reservations.delete(intentId);
  }

  check(input: SimulationGuardInput, now: Date): SimulationGuardResult {
    const reasons: string[] = [];
    let safeIntentId: string | null = null;
    try { safeIntentId = id(input?.intent?.id); } catch { /* Never echo untrusted IDs. */ }
    const result = (status: SimulationGuardResult['status']): SimulationGuardResult => Object.freeze({
      status, reasons: Object.freeze([...new Set(reasons)]),
      intentId: safeIntentId,
      policyVersion: this.policy.version
    });
    if (!Number.isFinite(now.getTime())) {
      reasons.push('INVALID_CLOCK');
      return result('BLOCKED');
    }
    try {
      const { candidate, intelligence, tokenFacts, portfolio, intent, quoteRequest,
        quote, balance, walletId } = input;
      const proposal = parseScreenerProposal(input.proposal);
      const tokenRisk = assessTokenRisk(candidate, intelligence, tokenFacts, this.policy, now);
      if (tokenRisk.status !== 'PASS') reasons.push(...tokenRisk.reasons);
      const pending = [...this.reservations.values()].filter((item) => item.walletId === walletId);
      const reserved = pending.reduce((sum, item) => sum + item.amount, 0n);
      const baseRisk = assessPortfolioRisk(portfolio, walletId, intent.mint, intent.amountRaw,
        this.policy, now);
      if (baseRisk.status !== 'PASS') reasons.push(...baseRisk.reasons);
      else if (portfolio && pending.length > 0) {
        const exposureByMint = { ...portfolio.exposureByMint };
        const newMints = new Set<string>();
        for (const item of pending) {
          if (!Object.hasOwn(portfolio.exposureByMint!, item.mint)) newMints.add(item.mint);
          exposureByMint[item.mint] = (units(exposureByMint[item.mint] ?? '0') + item.amount).toString();
        }
        const portfolioRisk = assessPortfolioRisk({
          ...portfolio, exposureByMint,
          pendingExposureQuoteRaw: (units(portfolio.pendingExposureQuoteRaw) + reserved).toString(),
          activeOrderCount: portfolio.activeOrderCount! + pending.length,
          openPositionCount: portfolio.openPositionCount! + newMints.size
        }, walletId, intent.mint, intent.amountRaw, this.policy, now);
        if (portfolioRisk.status !== 'PASS') reasons.push(...portfolioRisk.reasons);
      }

      id(walletId);
      id(intent.id);
      if (this.usedIntentIds.has(intent.id)) reasons.push('DUPLICATE_INTENT');
      if (this.usedIntentIds.size >= 10_000) reasons.push('SIMULATION_SESSION_FULL');
      if (proposal.action !== 'BUY' || proposal.candidateId !== candidate.id ||
          proposal.snapshotId !== intelligence.snapshotId ||
          proposal.evidenceIds.some((evidenceId) => !intelligence.evidenceIds.includes(evidenceId)) ||
          !recent(proposal.createdAt, now, 300_000) ||
          Date.parse(proposal.expiresAt) <= now.getTime()) reasons.push('PROPOSAL_INVALID');
      if (intent.side !== 'BUY' || intent.mint !== candidate.mint ||
          intent.policyVersion !== this.policy.version ||
          Date.parse(parseIsoTime(intent.expiresAt)) <= now.getTime() ||
          Date.parse(intent.expiresAt) > now.getTime() + 60_000) reasons.push('INTENT_INVALID');
      if (!validSolanaAddress(candidate.mint) || !validSolanaAddress(intent.mint)) {
        reasons.push('MINT_INVALID');
      }
      const amount = units(intent.amountRaw);
      const minimum = units(intent.minOutputRaw);
      const feeLimit = units(intent.maxFeeRaw);
      if (amount === 0n || minimum === 0n || feeLimit > units(this.policy.maxFeeRaw) ||
          !Number.isInteger(intent.maxSlippageBps) || intent.maxSlippageBps < 0 ||
          intent.maxSlippageBps > this.policy.maxSlippageBps) reasons.push('INTENT_LIMIT');
      if (quoteRequest.poolId !== intelligence.market?.poolId ||
          quoteRequest.inputMint !== this.policy.quoteMint ||
          quoteRequest.outputMint !== candidate.mint || quoteRequest.inputMint === quoteRequest.outputMint ||
          quoteRequest.amountInRaw !== intent.amountRaw ||
          quoteRequest.maxSlippageBps !== intent.maxSlippageBps ||
          !recent(quoteRequest.requestedAt, now, 15_000)) reasons.push('QUOTE_REQUEST_INVALID');
      id(quoteRequest.id);

      if (!quote || quote.requestId !== quoteRequest.id ||
          !recent(quote.observedAt, now, 15_000) ||
          Date.parse(quote.observedAt) < Date.parse(quoteRequest.requestedAt) ||
          Date.parse(parseIsoTime(quote.expiresAt)) <= now.getTime() ||
          Date.parse(quote.expiresAt) > Date.parse(quote.observedAt) + 60_000 ||
          quote.evidenceIds.length === 0 || quote.evidenceIds.length > 20 ||
          quote.evidenceIds.some((evidenceId) => !id(evidenceId)) ||
          quote.priceImpactBps === null ||
          !Number.isInteger(quote.priceImpactBps) || quote.priceImpactBps < 0 ||
          quote.priceImpactBps > this.policy.maxPriceImpactBps) {
        reasons.push('QUOTE_MISSING_OR_STALE');
      } else {
        const expected = units(quote.expectedOutputRaw);
        const quotedMinimum = units(quote.minOutputRaw);
        const minBySlippage = expected * BigInt(10_000 - intent.maxSlippageBps) / 10_000n;
        if (expected === 0n || quotedMinimum === 0n || quotedMinimum > expected ||
            quotedMinimum < minimum || minimum < minBySlippage ||
            quotedMinimum < minBySlippage || units(quote.estimatedFeeRaw) > feeLimit) {
          reasons.push('QUOTE_LIMIT');
        }
      }
      if (!balance || balance.walletId !== walletId ||
          balance.mint !== this.policy.quoteMint ||
          !recent(balance.observedAt, now, 30_000) ||
          units(balance.amountRaw) < amount + reserved || !id(balance.sourceId)) {
        reasons.push('BALANCE_MISSING_OR_STALE');
      }
      if (!Array.isArray(input.instructionProgramIds) ||
          input.instructionProgramIds.length === 0 || input.instructionProgramIds.length > 8 ||
          input.instructionProgramIds.some((program) =>
            typeof program !== 'string' || !this.policy.allowedProgramIds.includes(program))) {
        reasons.push('INSTRUCTION_PROGRAM_NOT_ALLOWED');
      }
      if (reasons.length > 0) return result('BLOCKED');
      this.usedIntentIds.add(intent.id);
      this.reservations.set(intent.id, { walletId, mint: intent.mint, amount });
      return result('SIMULATION_ALLOWED');
    } catch {
      reasons.push('INVALID_GUARD_INPUT');
      return result('BLOCKED');
    }
  }
}
