import type { RiskPolicyConfig } from './policy.ts';
import { id, recent, units } from './policy.ts';
import { validSolanaAddress } from '../core/address.ts';

export type PortfolioSnapshot = Readonly<{
  walletId: string;
  quoteMint: string;
  observedAt: string;
  sourceId: string;
  killSwitch: boolean | null;
  dailyLossQuoteRaw: string | null;
  totalExposureQuoteRaw: string | null;
  // Quote input reserved by unfilled BUY orders outside this guard instance.
  pendingExposureQuoteRaw: string | null;
  // Includes committed and pending exposure, grouped by mint.
  exposureByMint: Readonly<Record<string, string>> | null;
  openPositionCount: number | null;
  activeOrderCount: number | null;
  unresolvedOrderCount: number | null;
}>;

export type PortfolioRiskResult = Readonly<{
  status: 'PASS' | 'REJECT' | 'UNKNOWN';
  reasons: readonly string[];
}>;

export function assessPortfolioRisk(snapshot: PortfolioSnapshot | null, walletId: string,
  mint: string, newExposureRaw: string, policy: RiskPolicyConfig, now: Date): PortfolioRiskResult {
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
    if (!validSolanaAddress(mint) || !snapshot.exposureByMint ||
        Array.isArray(snapshot.exposureByMint) || Object.keys(snapshot.exposureByMint).length > 200) {
      unknown.push('POSITION_EXPOSURE_UNKNOWN');
    } else {
      const entries = Object.entries(snapshot.exposureByMint);
      if (entries.some(([key, value]) => !validSolanaAddress(key) || units(value) === 0n)) {
        throw new Error('Invalid position exposure');
      }
      // Pending buys occupy future position slots even before they fill.
      const projectedMints = new Set([...entries.map(([key]) => key), mint]);
      if (projectedMints.size > policy.maxOpenPositions) rejected.push('OPEN_POSITION_LIMIT');
      const existing = units(snapshot.exposureByMint[mint] ?? '0');
      if (existing + amount > units(policy.maxPositionQuoteRaw)) rejected.push('POSITION_LIMIT');
      if (snapshot.totalExposureQuoteRaw !== null && snapshot.pendingExposureQuoteRaw !== null &&
          entries.reduce((sum, [, value]) => sum + units(value), 0n) !==
          units(snapshot.totalExposureQuoteRaw) + units(snapshot.pendingExposureQuoteRaw)) {
        unknown.push('POSITION_EXPOSURE_MISMATCH');
      }
    }
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
