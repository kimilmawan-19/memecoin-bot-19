import type { MarketContext, OpenPosition } from '../core/models.ts';
import { parseChangeBps, parseIsoTime, parseSignedBaseUnits } from '../core/invariants.ts';
import { parseMarketContext } from '../core/market.ts';
import { validSolanaAddress } from '../core/address.ts';
import { id, recent, units } from '../risk/policy.ts';

// Phase 8 observations are fixtures. A live source must verify valuation,
// creator activity, and the persisted peak before these rules gain authority.
export type PositionObservation = Readonly<{
  sourceKind: 'FIXTURE';
  sourceId: string;
  snapshotId: string;
  positionId: string;
  positionVersion: number;
  market: MarketContext | null;
  observedAt: string;
  markValueQuoteRaw: string | null;
  liquidityQuoteRaw: string | null;
  devSellVerified: boolean | null;
  organicNetFlowRaw: string | null;
  organicBuyerGrowthBps: number | null;
  evidenceIds: readonly string[];
}>;

export type ExitPolicy = Readonly<{
  stopLossBps: number;
  takeProfitBps: number | null;
  trailingStopBps: number;
  maxHoldMs: number;
  minLiquidityQuoteRaw: string;
}>;

export type ExitSignal = Readonly<{
  status: 'EXIT' | 'NONE' | 'UNKNOWN';
  reasons: readonly string[];
}>;

export function parseExitPolicy(value: unknown): ExitPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid exit policy');
  const raw = value as Record<string, unknown>;
  const keys = ['stopLossBps', 'takeProfitBps', 'trailingStopBps', 'maxHoldMs', 'minLiquidityQuoteRaw'];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      !Number.isSafeInteger(raw.stopLossBps) || (raw.stopLossBps as number) < 1 ||
      (raw.stopLossBps as number) >= 10_000 ||
      (raw.takeProfitBps !== null && (!Number.isSafeInteger(raw.takeProfitBps) ||
        (raw.takeProfitBps as number) < 1 || (raw.takeProfitBps as number) > 100_000)) ||
      !Number.isSafeInteger(raw.trailingStopBps) || (raw.trailingStopBps as number) < 1 ||
      (raw.trailingStopBps as number) >= 10_000 ||
      !Number.isSafeInteger(raw.maxHoldMs) || (raw.maxHoldMs as number) < 60_000 ||
      (raw.maxHoldMs as number) > 30 * 24 * 60 * 60_000 ||
      units(raw.minLiquidityQuoteRaw) === 0n) throw new Error('Invalid exit policy');
  return Object.freeze({
    stopLossBps: raw.stopLossBps as number,
    takeProfitBps: raw.takeProfitBps as number | null,
    trailingStopBps: raw.trailingStopBps as number,
    maxHoldMs: raw.maxHoldMs as number,
    minLiquidityQuoteRaw: units(raw.minLiquidityQuoteRaw).toString()
  });
}

export function assessExit(position: OpenPosition, observation: PositionObservation,
  policy: ExitPolicy, now: Date): ExitSignal {
  const unknown = (reason: string): ExitSignal => Object.freeze({
    status: 'UNKNOWN', reasons: Object.freeze([reason])
  });
  try {
    if (!Number.isFinite(now.getTime()) || !validSolanaAddress(position.mint) ||
        !id(position.id) || !id(position.walletId) ||
        !Number.isSafeInteger(position.version) || position.version < 0 ||
        position.status !== 'OPEN' || position.exitIntentId !== null ||
        units(position.quantityRaw) === 0n ||
        units(position.costQuoteRaw) === 0n ||
        units(position.peakValueQuoteRaw) < units(position.costQuoteRaw) ||
        Date.parse(parseIsoTime(position.openedAt)) > now.getTime() ||
        observation.sourceKind !== 'FIXTURE' || !id(observation.sourceId) ||
        !id(observation.snapshotId) || observation.positionId !== position.id ||
        observation.positionVersion !== position.version ||
        observation.evidenceIds.length < 1 || observation.evidenceIds.length > 20 ||
        observation.evidenceIds.some((item) => !id(item))) return unknown('POSITION_OR_OBSERVATION_INVALID');
    parseSignedBaseUnits(position.realizedPnlQuoteRaw);
    const market = parseMarketContext(observation.market);
    if (market.windowTo !== observation.observedAt) return unknown('MARKET_CONTEXT_MISMATCH');
    const maxHold = now.getTime() - Date.parse(position.openedAt) >= policy.maxHoldMs;
    if (!recent(observation.observedAt, now, 60_000)) {
      return maxHold ? Object.freeze({ status: 'EXIT',
        reasons: Object.freeze(['MAX_HOLD']) }) : unknown('OBSERVATION_STALE');
    }
    if (observation.organicNetFlowRaw !== null) parseSignedBaseUnits(observation.organicNetFlowRaw);
    if (observation.organicBuyerGrowthBps !== null) parseChangeBps(observation.organicBuyerGrowthBps);
    if (observation.devSellVerified !== null && typeof observation.devSellVerified !== 'boolean') {
      return unknown('DEV_ACTIVITY_INVALID');
    }
    const reasons: string[] = [];
    if (observation.devSellVerified === true) reasons.push('VERIFIED_DEV_SELL');
    if (observation.liquidityQuoteRaw !== null &&
        units(observation.liquidityQuoteRaw) < units(policy.minLiquidityQuoteRaw)) {
      reasons.push('LIQUIDITY_COLLAPSE');
    }
    if (observation.markValueQuoteRaw !== null) {
      const mark = units(observation.markValueQuoteRaw);
      const cost = units(position.costQuoteRaw);
      const peak = units(position.peakValueQuoteRaw);
      if (mark * 10_000n <= cost * BigInt(10_000 - policy.stopLossBps)) {
        reasons.push('STOP_LOSS');
      }
      if (peak > cost && mark * 10_000n <= peak * BigInt(10_000 - policy.trailingStopBps)) {
        reasons.push('TRAILING_STOP');
      }
      if (policy.takeProfitBps !== null &&
          mark * 10_000n >= cost * BigInt(10_000 + policy.takeProfitBps)) {
        reasons.push('TAKE_PROFIT');
      }
    }
    if (maxHold) reasons.push('MAX_HOLD');
    if (reasons.length) return Object.freeze({ status: 'EXIT', reasons: Object.freeze(reasons) });
    if (observation.markValueQuoteRaw === null || observation.liquidityQuoteRaw === null ||
        observation.devSellVerified === null) return unknown('CRITICAL_POSITION_FACT_UNKNOWN');
    return Object.freeze({ status: 'NONE', reasons: Object.freeze([]) });
  } catch {
    return unknown('POSITION_OR_OBSERVATION_INVALID');
  }
}
