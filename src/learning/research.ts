import type { ClosedTrade, Lesson } from '../core/models.ts';
import { parseBasisPoints, parseChangeBps, parseIsoTime,
  parseSignedBaseUnits } from '../core/invariants.ts';
import { immutableSnapshot } from '../core/snapshot.ts';

const ID = /^[a-zA-Z0-9._-]{1,64}$/;
const EVIDENCE_ID = /^[a-zA-Z0-9:._-]{1,128}$/;
const METRICS = ['organicBuyerGrowthBps', 'freshWalletBps',
  'bundleConcentrationBps', 'liquidityGrowthBps'] as const;
export type ResearchMetric = typeof METRICS[number];

export type ResearchFeatures = Readonly<{
  snapshotId: string;
  observedAt: string;
  organicBuyerGrowthBps: number | null;
  freshWalletBps: number | null;
  bundleConcentrationBps: number | null;
  liquidityGrowthBps: number | null;
}>;
export type ResearchCase = Readonly<{ trade: ClosedTrade; features: ResearchFeatures }>;
export type ResearchDataset = Readonly<{
  id: string;
  sourceKind: 'FIXTURE';
  cases: readonly ResearchCase[];
}>;
export type ThresholdReview = Readonly<{
  metric: ResearchMetric;
  comparator: '>=' | '<=';
  valueBps: number;
}>;
export type ResearchReport = Readonly<{
  id: string;
  dataset: ResearchDataset;
  lesson: Lesson;
  thresholdReview: ThresholdReview | null;
  modelVersion: string;
  promptVersion: string;
}>;
export type FeatureDistribution = Readonly<{
  count: number;
  minBps: number | null;
  medianBps: number | null;
  maxBps: number | null;
}>;

function identifier(value: unknown, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid research evidence');
  return value;
}
function uniqueIds(value: unknown, min: number, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error('Invalid research evidence');
  }
  const ids = value.map((item) => identifier(item, EVIDENCE_ID));
  if (new Set(ids).size !== ids.length) throw new Error('Invalid research evidence');
  return ids;
}
function metric(value: unknown, signed: boolean): number | null {
  return value === null ? null : signed ? parseChangeBps(value) : parseBasisPoints(value);
}

// Closed outcomes and feature snapshots are copied into a strict, bounded
// fixture dataset. A feature timestamp after entry would leak future data.
export function parseResearchDataset(value: unknown): ResearchDataset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid research dataset');
  const raw = value as Record<string, unknown>;
  if (raw.sourceKind !== 'FIXTURE' || !Array.isArray(raw.cases) ||
      raw.cases.length < 20 || raw.cases.length > 100) throw new Error('Invalid research dataset');
  const seenTrades = new Set<string>();
  const seenPositions = new Set<string>();
  const cases = raw.cases.map((item: unknown): ResearchCase => {
    if (!item || typeof item !== 'object') throw new Error('Invalid research case');
    const input = item as Record<string, unknown>;
    if (!input.trade || typeof input.trade !== 'object' ||
        !input.features || typeof input.features !== 'object') throw new Error('Invalid research case');
    const trade = input.trade as Record<string, unknown>;
    const features = input.features as Record<string, unknown>;
    const id = identifier(trade.id, EVIDENCE_ID);
    const positionId = identifier(trade.positionId, EVIDENCE_ID);
    if (seenTrades.has(id) || seenPositions.has(positionId) || trade.reconciled !== true) {
      throw new Error('Invalid research case');
    }
    seenTrades.add(id);
    seenPositions.add(positionId);
    const openedAt = parseIsoTime(trade.openedAt);
    const closedAt = parseIsoTime(trade.closedAt);
    const observedAt = parseIsoTime(features.observedAt);
    if (Date.parse(observedAt) > Date.parse(openedAt) ||
        Date.parse(closedAt) <= Date.parse(openedAt)) throw new Error('Invalid research time');
    const normalizedTrade: ClosedTrade = {
      id, positionId, openedAt, closedAt,
      realizedPnlQuoteRaw: parseSignedBaseUnits(trade.realizedPnlQuoteRaw),
      reconciled: true, evidenceIds: uniqueIds(trade.evidenceIds, 1, 20)
    };
    const normalizedFeatures: ResearchFeatures = {
      snapshotId: identifier(features.snapshotId, EVIDENCE_ID), observedAt,
      organicBuyerGrowthBps: metric(features.organicBuyerGrowthBps, true),
      freshWalletBps: metric(features.freshWalletBps, false),
      bundleConcentrationBps: metric(features.bundleConcentrationBps, false),
      liquidityGrowthBps: metric(features.liquidityGrowthBps, true)
    };
    if (METRICS.every((key) => normalizedFeatures[key] === null)) {
      throw new Error('Invalid research case');
    }
    return { trade: normalizedTrade, features: normalizedFeatures };
  });
  const wins = cases.filter((item) => BigInt(item.trade.realizedPnlQuoteRaw) > 0n).length;
  const losses = cases.filter((item) => BigInt(item.trade.realizedPnlQuoteRaw) < 0n).length;
  if (wins < 5 || losses < 5) throw new Error('Insufficient outcome diversity');
  return immutableSnapshot({ id: identifier(raw.id), sourceKind: 'FIXTURE', cases });
}

// Descriptive statistics only. They are not confidence intervals or proof of
// predictive value; the model receives these instead of doing arithmetic itself.
export function summarizeResearchDataset(value: ResearchDataset) {
  const dataset = parseResearchDataset(value);
  const distribution = (metricName: ResearchMetric, outcome: 'WIN' | 'LOSS'): FeatureDistribution => {
    const values = dataset.cases
      .filter((item) => outcome === 'WIN' ?
        BigInt(item.trade.realizedPnlQuoteRaw) > 0n :
        BigInt(item.trade.realizedPnlQuoteRaw) < 0n)
      .map((item) => item.features[metricName])
      .filter((item): item is number => item !== null)
      .sort((a, b) => a - b);
    return Object.freeze({ count: values.length, minBps: values[0] ?? null,
      medianBps: values.length ? values[Math.floor((values.length - 1) / 2)] : null,
      maxBps: values.at(-1) ?? null });
  };
  const features = Object.fromEntries(METRICS.map((name) => [name, {
    wins: distribution(name, 'WIN'), losses: distribution(name, 'LOSS')
  }]));
  return immutableSnapshot({ outcomes: {
    wins: dataset.cases.filter((item) => BigInt(item.trade.realizedPnlQuoteRaw) > 0n).length,
    losses: dataset.cases.filter((item) => BigInt(item.trade.realizedPnlQuoteRaw) < 0n).length,
    flat: dataset.cases.filter((item) => BigInt(item.trade.realizedPnlQuoteRaw) === 0n).length
  }, features });
}

export function parseThresholdReview(value: unknown): ThresholdReview | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid threshold review');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3 ||
      !METRICS.includes(raw.metric as ResearchMetric) ||
      (raw.comparator !== '>=' && raw.comparator !== '<=')) {
    throw new Error('Invalid threshold review');
  }
  const signed = raw.metric === 'organicBuyerGrowthBps' || raw.metric === 'liquidityGrowthBps';
  return Object.freeze({ metric: raw.metric as ResearchMetric,
    comparator: raw.comparator, valueBps: signed ? parseChangeBps(raw.valueBps) :
      parseBasisPoints(raw.valueBps) });
}

export function parseResearchReport(value: unknown): ResearchReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid research report');
  const raw = value as Record<string, unknown>;
  const expected = ['id', 'dataset', 'lesson', 'thresholdReview', 'modelVersion', 'promptVersion'];
  if (Object.keys(raw).length !== expected.length || expected.some((key) => !Object.hasOwn(raw, key)) ||
      !raw.lesson || typeof raw.lesson !== 'object') throw new Error('Invalid research report');
  const dataset = parseResearchDataset(raw.dataset);
  const lesson = raw.lesson as Record<string, unknown>;
  const lessonKeys = ['id', 'version', 'status', 'rule', 'supportingTradeIds',
    'counterexampleTradeIds', 'proposedAt'];
  if (Object.keys(lesson).length !== lessonKeys.length ||
      lessonKeys.some((key) => !Object.hasOwn(lesson, key)) ||
      lesson.id !== raw.id || lesson.version !== 1 || lesson.status !== 'PROPOSED' ||
      typeof lesson.rule !== 'string' || lesson.rule.length < 1 ||
      lesson.rule.length > 200 || /[\x00-\x1f\x7f]/.test(lesson.rule)) {
    throw new Error('Invalid research report');
  }
  const support = uniqueIds(lesson.supportingTradeIds, 3, 20);
  const counter = uniqueIds(lesson.counterexampleTradeIds, 2, 20);
  if (support.some((id) => counter.includes(id))) throw new Error('Overlapping research evidence');
  const byId = new Map(dataset.cases.map((item) => [item.trade.id, item.trade]));
  if (support.some((id) => !byId.has(id) || BigInt(byId.get(id)!.realizedPnlQuoteRaw) <= 0n) ||
      counter.some((id) => !byId.has(id) || BigInt(byId.get(id)!.realizedPnlQuoteRaw) >= 0n)) {
    throw new Error('Unsupported research evidence');
  }
  const lastClose = Math.max(...dataset.cases.map((item) => Date.parse(item.trade.closedAt)));
  const proposedAt = parseIsoTime(lesson.proposedAt);
  if (Date.parse(proposedAt) < lastClose) throw new Error('Research uses future outcomes');
  const thresholdReview = parseThresholdReview(raw.thresholdReview);
  if (thresholdReview) {
    const featuresByTrade = new Map(dataset.cases.map((item) => [item.trade.id, item.features]));
    if ([...support, ...counter].some((id) =>
      featuresByTrade.get(id)?.[thresholdReview.metric] == null)) {
      throw new Error('Missing threshold evidence');
    }
    const summary = summarizeResearchDataset(dataset).features[thresholdReview.metric];
    if (summary.wins.count < 5 || summary.losses.count < 5) {
      throw new Error('Insufficient threshold coverage');
    }
  }
  return immutableSnapshot({ id: identifier(raw.id), dataset,
    lesson: { id: identifier(lesson.id), version: 1, status: 'PROPOSED',
      rule: lesson.rule, supportingTradeIds: support,
      counterexampleTradeIds: counter, proposedAt },
    thresholdReview,
    modelVersion: identifier(raw.modelVersion), promptVersion: identifier(raw.promptVersion) });
}
