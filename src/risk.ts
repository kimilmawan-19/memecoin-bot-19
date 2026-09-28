import type { CandidateSnapshot, GateResult } from './domain.ts';

const MAX_AGE_MS = 5 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 30 * 1000;

export function assessRisk(candidate: CandidateSnapshot, now: Date): GateResult {
  const rejected: string[] = [];
  const unknown: string[] = [];
  const ageMs = now.getTime() - Date.parse(candidate.observedAt);
  if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS || ageMs < -FUTURE_TOLERANCE_MS) {
    unknown.push('STALE_OR_INVALID_OBSERVATION');
  }
  if (candidate.risk.mintAuthorityRevoked === false) rejected.push('MINT_AUTHORITY_ACTIVE');
  if (candidate.risk.freezeAuthorityRevoked === false) rejected.push('FREEZE_AUTHORITY_ACTIVE');
  if (candidate.risk.liquidityUsd === 0) rejected.push('NO_LIQUIDITY');
  if (candidate.risk.mintAuthorityRevoked === null) unknown.push('MINT_AUTHORITY_UNKNOWN');
  if (candidate.risk.freezeAuthorityRevoked === null) unknown.push('FREEZE_AUTHORITY_UNKNOWN');
  if (candidate.risk.liquidityUsd === null) unknown.push('LIQUIDITY_UNKNOWN');
  if (rejected.length) return { status: 'REJECT', reasons: [...rejected, ...unknown] };
  if (unknown.length) return { status: 'UNKNOWN', reasons: unknown };
  return { status: 'PASS', reasons: [] };
}
