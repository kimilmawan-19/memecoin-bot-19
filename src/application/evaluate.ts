import type {
  ScreenerProposal, TokenCandidate, TokenIntelligence, TokenRiskAssessment
} from '../core/models.ts';
import { parseIsoTime } from '../core/invariants.ts';
import { parseScreenerProposal } from '../core/proposal.ts';
import type { DecisionJournal, RiskPolicy, ScreenerAgent } from './ports.ts';

const MAX_AGE_MS = 5 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 30 * 1000;

function fresh(value: string, now: Date): boolean {
  try {
    const age = now.getTime() - Date.parse(parseIsoTime(value));
    return age >= -FUTURE_TOLERANCE_MS && age <= MAX_AGE_MS;
  } catch {
    return false;
  }
}

function skip(candidate: TokenCandidate, intelligence: TokenIntelligence, now: Date,
  reason: string): ScreenerProposal {
  return Object.freeze({
    candidateId: candidate.id,
    snapshotId: intelligence.snapshotId,
    action: 'SKIP',
    rationale: reason,
    risks: Object.freeze([reason]),
    evidenceIds: Object.freeze([...intelligence.evidenceIds]),
    modelVersion: 'deterministic-1',
    promptVersion: 'none',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  });
}

export type Evaluation = Readonly<{
  risk: TokenRiskAssessment;
  proposal: ScreenerProposal;
}>;

// Orchestrates a single candidate. No execution port exists in this service.
export async function evaluateCandidate(
  candidate: TokenCandidate,
  intelligence: TokenIntelligence,
  policy: RiskPolicy,
  agent: ScreenerAgent,
  journal: DecisionJournal,
  now: Date
): Promise<Evaluation> {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid evaluation time');
  let assessed: TokenRiskAssessment;
  try {
    assessed = policy.assess(candidate, intelligence);
  } catch {
    assessed = {
      candidateId: candidate.id,
      policyVersion: 'unavailable',
      status: 'UNKNOWN',
      reasons: ['RISK_POLICY_ERROR'],
      checkedAt: now.toISOString(),
      evidenceIds: []
    };
  }
  const metrics = [intelligence.organic, intelligence.wallets, intelligence.manipulation,
    intelligence.holders, intelligence.liquidity];
  const evidenceValid = candidate.id === intelligence.candidateId &&
    assessed.candidateId === candidate.id &&
    candidate.evidenceIds.length > 0 && intelligence.evidenceIds.length > 0 &&
    assessed.evidenceIds.length > 0 &&
    (intelligence.conflictFields?.length ?? 0) === 0 &&
    fresh(intelligence.asOf, now) && fresh(assessed.checkedAt, now) &&
    metrics.every((metric) => metric.sourceIds.length > 0 && metric.coverageBps > 0 &&
      metric.confidenceBps > 0 && fresh(metric.observedAt, now));
  const risk: TokenRiskAssessment = evidenceValid ? assessed : {
    ...assessed,
    candidateId: candidate.id,
    status: 'UNKNOWN',
    reasons: [...assessed.reasons, 'MISSING_OR_STALE_EVIDENCE'],
    checkedAt: now.toISOString()
  };

  let proposal: ScreenerProposal;
  if (risk.status !== 'PASS') {
    proposal = skip(candidate, intelligence, now, 'RISK_GATE_NOT_PASSED');
  } else {
    try {
      const parsed = parseScreenerProposal(await agent.propose(candidate, intelligence));
      if (parsed.candidateId !== candidate.id || parsed.snapshotId !== intelligence.snapshotId ||
          Date.parse(parsed.createdAt) > now.getTime() + FUTURE_TOLERANCE_MS ||
          Date.parse(parsed.expiresAt) <= now.getTime()) {
        throw new Error('Mismatched or expired proposal');
      }
      proposal = parsed;
    } catch {
      proposal = skip(candidate, intelligence, now, 'INVALID_AGENT_PROPOSAL');
    }
  }
  await journal.append(proposal, risk);
  return { risk, proposal };
}
