import type { RiskPolicyConfig } from './policy.ts';
import { id, recent, units } from './policy.ts';

export type PortfolioSnapshot = Readonly<{
  walletId: string;
  quoteMint: string;
  observedAt: string;
  sourceId: string;
  killSwitch: boolean | null;
  dailyLossQuoteRaw: string | null;
  totalExposureQuoteRaw: string | null;
  pendingExposureQuoteRaw: string | null;
  openPositionCount: number | null;
  activeOrderCount: number | null;
  unresolvedOrderCount: number | null;
}>;

export type PortfolioRiskResult = Readonly<{
  status: 'PASS' | 'REJECT' | 'UNKNOWN';
  reasons: readonly string[];
}>;

export function assessPortfolioRisk(snapshot: PortfolioSnapshot | null, walletId: string,
  newExposureRaw: string, policy: RiskPolicyConfig, now: Date): PortfolioRiskResult {
  if (!snapshot || snapshot.walletId !== walletId || snapshot.quoteMint !== policy.quoteMint ||
      !recent(snapshot.observedAt, now, 30_000)) {
    return { status: 'UNKNOWN', reasons: ['PORTFOLIO_MISSING_OR_STALE'] };
  }
  const rejected: string[] = [];
  const unknown: string[] = [];
  try {
    id(snapshot.sourceId);
    const amount = units(newExposureRaw);
    if (amount === 0n) rejected.push('ZERO_POSITION');
    if (amount > units(policy.maxPositionQuoteRaw)) rejected.push('POSITION_LIMIT');
    if (snapshot.killSwitch !== null && typeof snapshot.killSwitch !== 'boolean') {
      throw new Error('Invalid kill switch');
    }
    if (snapshot.killSwitch === true) rejected.push('KILL_SWITCH');
    if (snapshot.killSwitch === null) unknown.push('KILL_SWITCH_UNKNOWN');
    if (snapshot.dailyLossQuoteRaw === null) unknown.push('DAILY_LOSS_UNKNOWN');
    else if (units(snapshot.dailyLossQuoteRaw) >= units(policy.maxDailyLossQuoteRaw)) {
      rejected.push('DAILY_LOSS_LIMIT');
    }
    if (snapshot.totalExposureQuoteRaw === null || snapshot.pendingExposureQuoteRaw === null) {
      unknown.push('EXPOSURE_UNKNOWN');
    } else if (units(snapshot.totalExposureQuoteRaw) + units(snapshot.pendingExposureQuoteRaw) +
        amount > units(policy.maxTotalExposureQuoteRaw)) rejected.push('TOTAL_EXPOSURE_LIMIT');
    for (const value of [snapshot.openPositionCount, snapshot.activeOrderCount,
      snapshot.unresolvedOrderCount]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error('Invalid portfolio count');
      }
    }
    if (snapshot.openPositionCount === null || snapshot.activeOrderCount === null ||
        snapshot.unresolvedOrderCount === null) unknown.push('ORDER_STATE_UNKNOWN');
    else {
      if (snapshot.openPositionCount >= policy.maxOpenPositions) rejected.push('OPEN_POSITION_LIMIT');
      if (snapshot.activeOrderCount >= policy.maxConcurrentOrders) rejected.push('CONCURRENT_ORDER_LIMIT');
      if (snapshot.unresolvedOrderCount > 0) rejected.push('UNRESOLVED_ORDER');
    }
  } catch {
    unknown.push('INVALID_PORTFOLIO_FACT');
  }
  return Object.freeze({ status: rejected.length ? 'REJECT' : unknown.length ? 'UNKNOWN' : 'PASS',
    reasons: Object.freeze([...rejected, ...unknown]) });
}
