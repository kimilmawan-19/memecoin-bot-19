import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCandidate } from '../src/application/evaluate.ts';
import type { DecisionJournal, RiskPolicy, ScreenerAgent } from '../src/application/ports.ts';
import type { TokenCandidate, TokenIntelligence, TokenRiskAssessment } from '../src/core/models.ts';

const now = new Date('2026-09-28T00:00:00.000Z');
const evidence = { sourceIds: ['fixture-1'], observedAt: now.toISOString(),
  coverageBps: 10_000, confidenceBps: 10_000 } as const;
const candidate: TokenCandidate = { id: 'candidate-1', chain: 'solana',
  mint: 'So11111111111111111111111111111111111111112',
  discoveredAt: now.toISOString(), sourceId: 'fixture-1', evidenceIds: ['fixture-1'] };
const intelligence: TokenIntelligence = {
  candidateId: candidate.id, snapshotId: 'snapshot-1', asOf: now.toISOString(),
  organic: { ...evidence, organicScore: null, organicBuyerCount: 1,
    organicBuyerGrowthBps: null, organicBuyVolumeRaw: null, organicSellVolumeRaw: null,
    organicNetFlowRaw: null, organicVolumeAccelerationBps: null },
  wallets: { ...evidence, freshWalletBps: null, fundedWalletClusters: 1,
    repeatedBuyPatternBps: null, smartMoneyPresence: null },
  manipulation: { ...evidence, bundleConcentrationBps: 0, botHolderBps: null,
    washTradingProbabilityBps: null, commonFunderClusters: null,
    repetitiveTradeSizesBps: null, suspiciousRoundTrips: null },
  holders: { ...evidence, holderGrowthBps: null, top10Bps: 1000,
    devHoldingBps: null, whaleConcentrationBps: null },
  liquidity: { ...evidence, liquidityQuoteRaw: '1000000', liquidityGrowthBps: null,
    volumeToLiquidityBps: null, priceImpactBps: null },
  evidenceIds: ['fixture-1']
};

function harness(status: TokenRiskAssessment['status'], response: unknown) {
  let calls = 0;
  const logged: string[] = [];
  const policy: RiskPolicy = { assess: () => ({ candidateId: candidate.id, policyVersion: 'test-1',
    status, reasons: status === 'PASS' ? [] : ['UNKNOWN_CRITICAL_FACT'],
    checkedAt: now.toISOString(), evidenceIds: ['fixture-1'] }) };
  const agent: ScreenerAgent = { propose: async () => {
    calls++;
    return response as Awaited<ReturnType<ScreenerAgent['propose']>>;
  } };
  const journal: DecisionJournal = { append: async (proposal) => { logged.push(proposal.action); } };
  return { policy, agent, journal, calls: () => calls, logged };
}

const buy = { candidateId: candidate.id, snapshotId: intelligence.snapshotId,
  action: 'BUY', rationale: 'Contract test only', risks: ['unknown-market'],
  evidenceIds: ['fixture-1'], modelVersion: 'mock-1', promptVersion: 'test-1',
  createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };

test('UNKNOWN risk blocks agent and records SKIP', async () => {
  const h = harness('UNKNOWN', buy);
  const result = await evaluateCandidate(candidate, intelligence, h.policy, h.agent, h.journal, now);
  assert.equal(result.proposal.action, 'SKIP');
  assert.equal(h.calls(), 0);
  assert.deepEqual(h.logged, ['SKIP']);
});

test('stale intelligence overrides PASS and blocks agent', async () => {
  const h = harness('PASS', buy);
  const stale = { ...intelligence, asOf: '2026-09-27T00:00:00.000Z' };
  const result = await evaluateCandidate(candidate, stale, h.policy, h.agent, h.journal, now);
  assert.equal(result.risk.status, 'UNKNOWN');
  assert.equal(h.calls(), 0);
});

test('stale metric evidence overrides PASS and blocks agent', async () => {
  const h = harness('PASS', buy);
  const stale = { ...intelligence, organic: { ...intelligence.organic,
    observedAt: '2026-09-27T00:00:00.000Z' } };
  const result = await evaluateCandidate(candidate, stale, h.policy, h.agent, h.journal, now);
  assert.equal(result.risk.status, 'UNKNOWN');
  assert.equal(h.calls(), 0);
});

test('conflicting provider facts override PASS and block agent', async () => {
  const h = harness('PASS', buy);
  const conflicted = { ...intelligence, conflictFields: ['liquidity.liquidityQuoteRaw'] };
  const result = await evaluateCandidate(candidate, conflicted, h.policy, h.agent, h.journal, now);
  assert.equal(result.risk.status, 'UNKNOWN');
  assert.equal(result.proposal.action, 'SKIP');
  assert.equal(h.calls(), 0);
});

test('empty provider coverage overrides PASS and blocks agent', async () => {
  const h = harness('PASS', buy);
  const missing = { ...intelligence, liquidity: { ...intelligence.liquidity,
    liquidityQuoteRaw: null, coverageBps: 0 } };
  const result = await evaluateCandidate(candidate, missing, h.policy, h.agent, h.journal, now);
  assert.equal(result.risk.status, 'UNKNOWN');
  assert.equal(h.calls(), 0);
});

test('all-null metrics cannot pass on claimed coverage alone', async () => {
  const h = harness('PASS', buy);
  const empty = {
    ...intelligence,
    organic: { ...intelligence.organic, organicBuyerCount: null },
    wallets: { ...intelligence.wallets, fundedWalletClusters: null },
    manipulation: { ...intelligence.manipulation, bundleConcentrationBps: null },
    holders: { ...intelligence.holders, top10Bps: null },
    liquidity: { ...intelligence.liquidity, liquidityQuoteRaw: null }
  };
  const result = await evaluateCandidate(candidate, empty, h.policy, h.agent, h.journal, now);
  assert.equal(result.risk.status, 'UNKNOWN');
  assert.equal(result.proposal.action, 'SKIP');
  assert.equal(h.calls(), 0);
});

test('risk policy error fails closed and records a decision', async () => {
  const h = harness('PASS', buy);
  const broken: RiskPolicy = { assess: () => { throw new Error('provider secret'); } };
  const result = await evaluateCandidate(candidate, intelligence, broken, h.agent, h.journal, now);
  assert.equal(result.risk.status, 'UNKNOWN');
  assert.equal(result.proposal.action, 'SKIP');
  assert.equal(h.calls(), 0);
  assert.deepEqual(h.logged, ['SKIP']);
  assert.equal(JSON.stringify(result).includes('provider secret'), false);
});

test('valid BUY remains a logged proposal with no execution', async () => {
  const h = harness('PASS', buy);
  const result = await evaluateCandidate(candidate, intelligence, h.policy, h.agent, h.journal, now);
  assert.equal(result.proposal.action, 'BUY');
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.logged, ['BUY']);
});

test('malformed agent proposal fails closed', async () => {
  const h = harness('PASS', { ...buy, privateKey: 'secret' });
  const result = await evaluateCandidate(candidate, intelligence, h.policy, h.agent, h.journal, now);
  assert.equal(result.proposal.action, 'SKIP');
  assert.equal(result.proposal.rationale, 'INVALID_AGENT_PROPOSAL');
});
