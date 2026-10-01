import { createHash } from 'node:crypto';
import type { MarketContext, TokenCandidate, TokenIntelligence } from '../core/models.ts';
import { parseMarketContext, sameMarketContext } from '../core/market.ts';
import { parseBaseUnits, parseBasisPoints, parseChangeBps, parseIsoTime,
  parseRatioBps, parseSignedBaseUnits } from '../core/invariants.ts';

type Parser = (value: unknown) => string | number;
const count: Parser = (value) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid observation');
  }
  return value;
};
const fields = {
  organic: {
    organicScore: parseBasisPoints, organicBuyerCount: count,
    organicBuyerGrowthBps: parseChangeBps, organicBuyVolumeRaw: parseBaseUnits,
    organicSellVolumeRaw: parseBaseUnits, organicNetFlowRaw: parseSignedBaseUnits,
    organicVolumeAccelerationBps: parseChangeBps
  },
  wallets: {
    freshWalletBps: parseBasisPoints, fundedWalletClusters: count,
    repeatedBuyPatternBps: parseBasisPoints, smartMoneyPresence: count
  },
  manipulation: {
    bundleConcentrationBps: parseBasisPoints, botHolderBps: parseBasisPoints,
    washTradingProbabilityBps: parseBasisPoints, commonFunderClusters: count,
    repetitiveTradeSizesBps: parseBasisPoints, suspiciousRoundTrips: count
  },
  holders: {
    holderGrowthBps: parseChangeBps, top10Bps: parseBasisPoints,
    devHoldingBps: parseBasisPoints, whaleConcentrationBps: parseBasisPoints
  },
  liquidity: {
    liquidityQuoteRaw: parseBaseUnits, liquidityGrowthBps: parseChangeBps,
    volumeToLiquidityBps: parseRatioBps, priceImpactBps: parseBasisPoints
  }
} as const;
type Category = keyof typeof fields;
const categories = Object.keys(fields) as Category[];

export type Observation = Readonly<{
  candidateId: string;
  market: MarketContext;
  sourceId: string;
  evidenceId: string;
  observedAt: string;
  coverageBps: number;
  confidenceBps: number;
  metrics: Readonly<Partial<Record<Category, Readonly<Record<string, string | number | null>>>>>;
}>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid observation');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid observation');
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      !/^[a-zA-Z0-9:._-]+$/.test(value)) throw new Error('Invalid observation');
  return value;
}

// Provider payloads enter as unknown. No unknown property can enter domain data or logs.
export function parseObservation(value: unknown): Observation {
  const input = record(value);
  const top = ['candidateId', 'market', 'sourceId', 'evidenceId', 'observedAt',
    'coverageBps', 'confidenceBps', 'metrics'];
  keys(input, top, top);
  const rawMetrics = record(input.metrics);
  keys(rawMetrics, categories);
  const metrics: Partial<Record<Category, Record<string, string | number | null>>> = {};
  for (const category of categories) {
    if (!Object.hasOwn(rawMetrics, category)) continue;
    const raw = record(rawMetrics[category]);
    const parsers = fields[category] as Record<string, Parser>;
    keys(raw, Object.keys(parsers));
    if (Object.keys(raw).length === 0) throw new Error('Invalid observation');
    const parsed: Record<string, string | number | null> = {};
    for (const [field, item] of Object.entries(raw)) {
      parsed[field] = item === null ? null : parsers[field](item);
    }
    metrics[category] = Object.freeze(parsed);
  }
  return Object.freeze({
    market: parseMarketContext(input.market),
    candidateId: id(input.candidateId), sourceId: id(input.sourceId),
    evidenceId: id(input.evidenceId), observedAt: parseIsoTime(input.observedAt),
    coverageBps: parseBasisPoints(input.coverageBps),
    confidenceBps: parseBasisPoints(input.confidenceBps),
    metrics: Object.freeze(metrics)
  });
}

function metric(category: Category, observations: readonly Observation[], now: Date,
  conflicts: string[]) {
  const values: Record<string, string | number | null> = {};
  const sourceIds = new Set<string>();
  const times: number[] = [];
  const coverages: number[] = [];
  const confidences: number[] = [];
  for (const field of Object.keys(fields[category])) values[field] = null;
  for (const observation of observations) {
    const part = observation.metrics[category];
    if (!part) continue;
    sourceIds.add(observation.sourceId);
    times.push(Date.parse(observation.observedAt));
    coverages.push(observation.coverageBps);
    confidences.push(observation.confidenceBps);
    for (const [field, value] of Object.entries(part)) {
      if (value === null) continue;
      if (values[field] !== null && values[field] !== value) {
        conflicts.push(`${category}.${field}`);
        values[field] = null;
      } else if (!conflicts.includes(`${category}.${field}`)) {
        values[field] = value;
      }
    }
  }
  return Object.freeze({
    sourceIds: Object.freeze([...sourceIds].sort()),
    observedAt: new Date(times.length ? Math.min(...times) : now.getTime()).toISOString(),
    coverageBps: Object.values(values).some((value) => value !== null) ? Math.min(...coverages) : 0,
    confidenceBps: Object.values(values).some((value) => value !== null) ? Math.min(...confidences) : 0,
    ...values
  });
}

export function normalizeIntelligence(candidate: TokenCandidate, raw: readonly unknown[],
  now: Date): TokenIntelligence {
  if (!Number.isFinite(now.getTime()) || raw.length > 20) throw new Error('Invalid observation batch');
  const observations = raw.map(parseObservation);
  if (observations.some((item) => item.candidateId !== candidate.id)) {
    throw new Error('Mismatched observation');
  }
  if (observations.some((item) => item.market.quoteMint === candidate.mint ||
      item.market.poolId === candidate.mint || item.market.windowTo !== item.observedAt)) {
    throw new Error('Mismatched market context');
  }
  const conflicts: string[] = [];
  const byId = new Map<string, Observation>();
  for (const item of observations) {
    if (byId.has(item.evidenceId)) throw new Error('Duplicate evidence');
    byId.set(item.evidenceId, item);
  }
  const valid = observations.filter((item) => {
    const age = now.getTime() - Date.parse(item.observedAt);
    return age >= -30_000 && age <= 300_000;
  });
  const evidenceIds = Object.freeze(valid.map((item) => item.evidenceId).sort());
  const market = valid[0]?.market ?? null;
  const consistent = market === null || valid.every((item) => sameMarketContext(item.market, market));
  if (!consistent) conflicts.push('market');
  const usable = consistent ? valid : [];
  const content = {
    candidateId: candidate.id,
    market: consistent ? market : null,
    asOf: valid.length ? new Date(Math.min(...valid.map((item) =>
      Date.parse(item.observedAt)))).toISOString() : now.toISOString(),
    organic: metric('organic', usable, now, conflicts),
    wallets: metric('wallets', usable, now, conflicts),
    manipulation: metric('manipulation', usable, now, conflicts),
    holders: metric('holders', usable, now, conflicts),
    liquidity: metric('liquidity', usable, now, conflicts),
    evidenceIds,
    conflictFields: Object.freeze([...new Set(conflicts)].sort())
  };
  const digest = createHash('sha256').update(JSON.stringify({
    chain: candidate.chain, mint: candidate.mint, ...content
  })).digest('hex');
  return Object.freeze({ ...content, snapshotId: `snapshot:${digest}` }) as TokenIntelligence;
}
