import type { TokenCandidate, TokenIntelligence, TokenRiskAssessment } from '../core/models.ts';
import type { RiskPolicyConfig } from './policy.ts';
import { id, recent, units } from './policy.ts';

// PASS means fixture assertions passed, not that this token is safe to trade.
// Phase 6 accepts only synthetic facts. A future on-chain adapter must verify
// the mint account, program owner, pool/vault state and reserve at one slot.
export type TokenRiskFacts = Readonly<{
  candidateId: string;
  mint: string;
  quoteMint: string;
  sourceKind: 'FIXTURE';
  sourceId: string;
  observedAt: string;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  tokenProgramSupported: boolean | null;
  poolVaultVerified: boolean | null;
  supplyVerified: boolean | null;
  liquidityQuoteRaw: string | null;
}>;

export function assessTokenRisk(candidate: TokenCandidate, intelligence: TokenIntelligence,
  facts: TokenRiskFacts | null, policy: RiskPolicyConfig, now: Date): TokenRiskAssessment {
  const rejected: string[] = [];
  const unknown: string[] = [];
  const evidenceIds: string[] = [];
  if (candidate.id !== intelligence.candidateId ||
      candidate.evidenceIds.length === 0 ||
      intelligence.evidenceIds.length === 0 ||
      (intelligence.conflictFields?.length ?? 0) > 0 ||
      !recent(intelligence.asOf, now, 300_000)) unknown.push('INTELLIGENCE_UNVERIFIED');
  if (!facts || facts.sourceKind !== 'FIXTURE' ||
      facts.candidateId !== candidate.id || facts.mint !== candidate.mint ||
      facts.quoteMint !== policy.quoteMint || !recent(facts.observedAt, now, 60_000)) {
    unknown.push('TOKEN_FACTS_MISSING_OR_STALE');
  } else {
    try {
      evidenceIds.push(id(facts.sourceId));
      for (const value of [facts.mintAuthorityRevoked, facts.freezeAuthorityRevoked,
        facts.tokenProgramSupported, facts.poolVaultVerified, facts.supplyVerified]) {
        if (value !== null && typeof value !== 'boolean') throw new Error('Invalid token fact');
      }
      if (facts.mintAuthorityRevoked === false) rejected.push('MINT_AUTHORITY_ACTIVE');
      if (facts.freezeAuthorityRevoked === false) rejected.push('FREEZE_AUTHORITY_ACTIVE');
      if (facts.tokenProgramSupported === false) rejected.push('UNSUPPORTED_TOKEN_PROGRAM');
      if (facts.poolVaultVerified === false) rejected.push('POOL_VAULT_INVALID');
      if (facts.supplyVerified === false) rejected.push('SUPPLY_INVALID');
      if (facts.mintAuthorityRevoked === null || facts.freezeAuthorityRevoked === null ||
          facts.tokenProgramSupported === null || facts.poolVaultVerified === null ||
          facts.supplyVerified === null) unknown.push('CRITICAL_TOKEN_FACT_UNKNOWN');
      if (facts.liquidityQuoteRaw === null) unknown.push('LIQUIDITY_UNKNOWN');
      else if (units(facts.liquidityQuoteRaw) < units(policy.minLiquidityQuoteRaw)) {
        rejected.push('LIQUIDITY_BELOW_MINIMUM');
      }
    } catch {
      unknown.push('INVALID_TOKEN_FACT');
    }
  }
  return Object.freeze({
    candidateId: candidate.id,
    policyVersion: policy.version,
    status: rejected.length ? 'REJECT' : unknown.length ? 'UNKNOWN' : 'PASS',
    reasons: Object.freeze([...rejected, ...unknown]),
    checkedAt: now.toISOString(), evidenceIds: Object.freeze(evidenceIds)
  });
}
