import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TokenCandidate } from '../src/core/models.ts';
import { collectIntelligence } from '../src/intelligence/collect.ts';
import { parseFeatureFrame } from '../src/intelligence/feature-frame.ts';
import { deriveFeatureObservations, FEATURE_VERSION } from '../src/intelligence/features.ts';
import { normalizeIntelligence } from '../src/intelligence/normalize.ts';
import { FixtureFeatureProvider, loadFixtureFeatureProvider } from '../src/providers/feature-fixture.ts';

const path = fileURLToPath(new URL('../fixtures/features.json', import.meta.url));
const now = new Date('2026-09-28T00:10:00.000Z');
const mint = 'dpRqobsSJKmWcNkqnD3jL2PmeJTkuuZnsgXuj9xpump';
const candidate: TokenCandidate = {
  id: `solana:${mint}`, chain: 'solana', mint,
  discoveredAt: '2026-09-28T00:00:00.000Z', sourceId: 'fixture', evidenceIds: ['candidate-1']
};

async function rawFrame(): Promise<any> {
  const file = JSON.parse(await readFile(path, 'utf8'));
  return file.frames[0];
}

function result(raw: unknown) {
  return normalizeIntelligence(candidate, deriveFeatureObservations(parseFeatureFrame(raw)), now);
}

test('aligned synthetic frame produces versioned, attributed descriptive features', async () => {
  const fixture = await loadFixtureFeatureProvider(path);
  const data = await collectIntelligence(candidate, [fixture], now);
  assert.equal(data.organic.organicBuyerCount, 3);
  assert.equal(data.organic.organicBuyerGrowthBps, 5000);
  assert.equal(data.organic.organicBuyVolumeRaw, '350');
  assert.equal(data.organic.organicNetFlowRaw, '330');
  assert.equal(data.wallets.freshWalletBps, 3333);
  assert.equal(data.wallets.fundedWalletClusters, 0);
  assert.equal(data.manipulation.bundleConcentrationBps, 0);
  assert.equal(data.holders.top10Bps, 10000);
  assert.equal(data.holders.devHoldingBps, 5000);
  assert.equal(data.liquidity.liquidityGrowthBps, 2500);
  assert.equal(data.liquidity.volumeToLiquidityBps, 3700);
  assert.equal(data.organic.organicScore, null);
  assert.equal(data.manipulation.washTradingProbabilityBps, null);
  assert.equal(data.liquidity.priceImpactBps, null);
  assert.deepEqual(data.organic.sourceIds, ['feature-fixture']);
  assert.equal(data.organic.coverageBps, 8000);
  assert.equal(data.organic.confidenceBps, 6000);
  assert.equal(data.evidenceIds.length, 5);
  assert.ok(data.evidenceIds.every((id) => id.startsWith(`${FEATURE_VERSION}:synthetic-window-1:`)));
  assert.equal(data.snapshotId, result(await rawFrame()).snapshotId);
});

test('common funder and bot participants cannot inflate organic proxy', async () => {
  const raw = await rawFrame();
  raw.wallets[1].funder = raw.wallets[0].funder;
  raw.wallets[2].bot = true;
  const data = result(raw);
  assert.equal(data.wallets.fundedWalletClusters, 1);
  assert.equal(data.organic.organicBuyerCount, 0);
  assert.equal(data.organic.organicBuyVolumeRaw, '0');
  assert.equal(data.organic.organicBuyerGrowthBps, null);
  assert.equal(data.organic.organicScore, null);
});

test('bundle, repeated sizes, and exact round trips are heuristics only', async () => {
  const raw = await rawFrame();
  raw.current.trades[0].quoteRaw = '100';
  raw.current.trades[1].quoteRaw = '100';
  raw.current.trades[3].quoteRaw = '100';
  raw.current.trades[2].quoteRaw = '100';
  raw.current.trades[0].bundleId = 'bundle-a';
  raw.current.trades[1].bundleId = 'bundle-a';
  const data = result(raw);
  assert.equal(data.wallets.repeatedBuyPatternBps, 10000);
  assert.equal(data.manipulation.bundleConcentrationBps, 5000);
  assert.equal(data.manipulation.suspiciousRoundTrips, 1);
  assert.equal(data.manipulation.washTradingProbabilityBps, null);
});

test('missing attribution, incomplete holders, and unverified vault fail closed', async () => {
  const raw = await rawFrame();
  raw.wallets[0].funder = null;
  delete raw.current.trades[0].bundleId;
  raw.holders.accounts[3].vaultEvidence.poolStateVault = raw.holders.accounts[0].tokenAccount;
  const data = result(raw);
  assert.equal(data.organic.organicBuyerCount, null);
  assert.equal(data.organic.coverageBps, 0);
  assert.equal(data.manipulation.bundleConcentrationBps, null);
  assert.equal(data.holders.top10Bps, null);
  assert.equal(data.holders.coverageBps, 0);
  const partial = await rawFrame();
  partial.holders.accounts[1].balanceRaw = '100';
  assert.equal(result(partial).holders.top10Bps, null);
});

test('parser rejects pool switches, stale snapshots, time gaps, duplicates, secrets, and bad units', async () => {
  const raw = await rawFrame();
  assert.throws(() => parseFeatureFrame({ ...raw, privateKey: 'hidden' }));
  assert.throws(() => parseFeatureFrame({ ...raw, candidateId: 'solana:other' }));
  assert.throws(() => parseFeatureFrame({ ...raw, current: {
    ...raw.current, trades: [{ ...raw.current.trades[0], quoteRaw: '1.5' },
      ...raw.current.trades.slice(1)] } }));
  assert.throws(() => parseFeatureFrame({ ...raw, previous: {
    ...raw.previous, to: '2026-09-28T00:04:00.000Z' } }));
  assert.throws(() => parseFeatureFrame({ ...raw, liquidity: {
    ...raw.liquidity, previous: { ...raw.liquidity.previous,
      poolId: '11111111111111111111111111111111' } } }));
  assert.throws(() => parseFeatureFrame({ ...raw, liquidity: {
    ...raw.liquidity, previous: { ...raw.liquidity.previous,
      observedAt: '2026-09-27T00:05:00.000Z' } } }));
  assert.throws(() => parseFeatureFrame({ ...raw, holders: {
    ...raw.holders, previousObservedAt: '2026-09-27T00:05:00.000Z' } }));
  assert.throws(() => parseFeatureFrame({ ...raw, holders: {
    ...raw.holders, observedAt: '2026-09-27T00:10:00.000Z' } }));
  assert.throws(() => parseFeatureFrame({ ...raw, current: {
    ...raw.current, trades: [raw.current.trades[0], raw.current.trades[0]] } }));
  assert.throws(() => parseFeatureFrame({ ...raw, current: {
    ...raw.current, trades: [{ ...raw.current.trades[0], quoteRaw: '0' },
      ...raw.current.trades.slice(1)] } }));
  assert.throws(() => new FixtureFeatureProvider({ version: 1,
    frames: [raw], apiKey: 'hidden' }));
});

test('provenance changes with frame and stale frames are unavailable', async () => {
  const raw = await rawFrame();
  const edited = structuredClone(raw);
  edited.current.trades[0].quoteRaw = '201';
  assert.notEqual(result(raw).snapshotId, result(edited).snapshotId);
  const stale = normalizeIntelligence(candidate,
    deriveFeatureObservations(parseFeatureFrame(raw)), new Date('2026-09-28T00:20:00.000Z'));
  assert.deepEqual(stale.evidenceIds, []);
  assert.equal(stale.organic.organicBuyerCount, null);
});
