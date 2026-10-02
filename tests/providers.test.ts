import { marketAt, USDC } from './helpers/market.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TokenCandidate } from '../src/core/models.ts';
import { collectIntelligence, type ObservationProvider } from '../src/intelligence/collect.ts';
import { normalizeIntelligence, parseObservation } from '../src/intelligence/normalize.ts';
import { FixtureObservationProvider, loadFixtureProvider } from '../src/providers/fixture.ts';

const now = new Date('2026-09-28T00:00:00.000Z');
const candidate: TokenCandidate = {
  id: 'candidate-1', chain: 'solana', mint: 'So11111111111111111111111111111111111111112',
  discoveredAt: now.toISOString(), sourceId: 'fixture', evidenceIds: ['fixture-candidate-1']
};
const observation = {
  market: marketAt(now.toISOString(), USDC, 6),
  candidateId: candidate.id, sourceId: 'fixture', evidenceId: 'evidence-1',
  observedAt: now.toISOString(), coverageBps: 8000, confidenceBps: 7000,
  metrics: { liquidity: { liquidityQuoteRaw: '1000000000' }, holders: { top10Bps: 2500 } }
};

test('fixture loads and normalizes sparse data with source provenance', async () => {
  const fixture = await loadFixtureProvider(fileURLToPath(new URL('../fixtures/observations.json', import.meta.url)));
  const result = await collectIntelligence(candidate, [fixture], now);
  assert.equal(result.liquidity.liquidityQuoteRaw, '1000000000');
  assert.equal(result.holders.top10Bps, 2500);
  assert.equal(result.organic.organicScore, null);
  assert.equal(result.organic.coverageBps, 0);
  assert.deepEqual(result.evidenceIds, ['fixture-market-1']);
  assert.deepEqual(result.liquidity.sourceIds, ['fixture']);
});

test('strict boundary rejects secrets, unknown keys, and invalid units', () => {
  assert.throws(() => parseObservation({ ...observation, privateKey: 'hidden' }));
  assert.throws(() => parseObservation({ ...observation,
    metrics: { liquidity: { liquidityQuoteRaw: '1.5' } } }));
  assert.throws(() => parseObservation({ ...observation,
    metrics: { liquidity: { liquidityQuoteRaw: '1', apiKey: 'hidden' } } }));
  assert.throws(() => new FixtureObservationProvider({ version: 1,
    observations: [observation], secret: 'hidden' }));
});

test('stale facts are unavailable and conflicting providers are quarantined', () => {
  const stale = { ...observation, observedAt: '2026-09-27T00:00:00.000Z',
    market: marketAt('2026-09-27T00:00:00.000Z', USDC, 6) };
  const empty = normalizeIntelligence(candidate, [stale], now);
  assert.equal(empty.liquidity.liquidityQuoteRaw, null);
  assert.equal(empty.liquidity.coverageBps, 0);
  assert.deepEqual(empty.evidenceIds, []);
  const second = { ...observation, sourceId: 'other', evidenceId: 'evidence-2',
    metrics: { liquidity: { liquidityQuoteRaw: '2000000000' } } };
  const combined = normalizeIntelligence(candidate, [observation, second], now);
  assert.equal(combined.liquidity.liquidityQuoteRaw, null);
  assert.deepEqual(combined.conflictFields, ['liquidity.liquidityQuoteRaw']);
  assert.deepEqual(combined.liquidity.sourceIds, ['fixture', 'other']);
});

test('snapshot identity is stable for identical content and changes with facts', () => {
  const first = normalizeIntelligence(candidate, [observation], now);
  const repeated = normalizeIntelligence(candidate, [structuredClone(observation)], now);
  const changed = normalizeIntelligence(candidate, [{ ...observation,
    metrics: { ...observation.metrics, holders: { top10Bps: 9000 } } }], now);
  assert.equal(first.snapshotId, repeated.snapshotId);
  assert.notEqual(first.snapshotId, changed.snapshotId);
  const second = { ...observation, sourceId: 'other', evidenceId: 'evidence-2',
    metrics: { wallets: { fundedWalletClusters: 2 } } };
  assert.equal(normalizeIntelligence(candidate, [observation, second], now).snapshotId,
    normalizeIntelligence(candidate, [second, observation], now).snapshotId);
});

test('provider timeout, malformed response, and source spoofing fail closed', async () => {
  const hung: ObservationProvider = { id: 'hung', observe: async () =>
    new Promise<readonly unknown[]>(() => {}) };
  const broken: ObservationProvider = { id: 'broken', observe: async () => {
    throw new Error('secret-from-provider');
  } };
  const spoofed: ObservationProvider = { id: 'other', observe: async () => [observation] };
  const fixture = new FixtureObservationProvider({ version: 1, observations: [observation] });
  const result = await collectIntelligence(candidate, [hung, broken, spoofed, fixture], now, 5);
  assert.deepEqual(result.evidenceIds, ['evidence-1']);
  assert.equal(JSON.stringify(result).includes('secret-from-provider'), false);
  const onlyFailed = await collectIntelligence(candidate, [broken, spoofed], now, 5);
  assert.deepEqual(onlyFailed.evidenceIds, []);
  assert.equal(onlyFailed.liquidity.coverageBps, 0);
});

test('duplicate evidence from separate providers invalidates the snapshot', async () => {
  const first: ObservationProvider = { id: 'fixture', observe: async () => [observation] };
  const second: ObservationProvider = { id: 'other', observe: async () => [
    { ...observation, sourceId: 'other' }
  ] };
  const result = await collectIntelligence(candidate, [first, second], now);
  assert.deepEqual(result.evidenceIds, []);
  assert.equal(result.liquidity.liquidityQuoteRaw, null);
});

test('normalization rejects missing context and quarantines mixed markets or windows', () => {
  const { market, ...missing } = observation;
  assert.throws(() => parseObservation(missing));
  const token = { ...candidate, mint: 'dpRqobsSJKmWcNkqnD3jL2PmeJTkuuZnsgXuj9xpump' };
  for (const changed of [
    { ...market, quoteMint: candidate.mint, quoteDecimals: 9 },
    { ...market, poolId: '11111111111111111111111111111111' },
    { ...market, quoteDecimals: 7 },
    { ...market, windowFrom: '2026-09-27T23:59:00.000Z' }
  ]) {
    const second = { ...observation, evidenceId: 'other-market', market: changed };
    const combined = normalizeIntelligence(token, [observation, second], now);
    assert.equal(combined.market, null);
    assert.equal(combined.liquidity.liquidityQuoteRaw, null);
    assert.deepEqual(combined.conflictFields, ['market']);
    assert.equal(normalizeIntelligence(token, [second, observation], now).snapshotId, combined.snapshotId);
  }
});
