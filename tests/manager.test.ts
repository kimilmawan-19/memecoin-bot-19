import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketAt, POOL } from './helpers/market.ts';
import { LlmManagerAgent } from '../src/agents/manager/agent.ts';
import { buildManagerMessages } from '../src/agents/manager/prompt.ts';
import { reviewPosition } from '../src/application/manage.ts';
import type { ManagerAgent, PositionJournal } from '../src/application/position-ports.ts';
import { simulateGuardedSell } from '../src/application/simulate-sell.ts';
import type { DryRunTradeRequest } from '../src/application/trading-adapter.ts';
import type { OpenPosition, PositionProposal } from '../src/core/models.ts';
import { FnzeroDryRunAdapter } from '../src/execution/fnzero/dry-run.ts';
import { assessExit, type ExitPolicy, type PositionObservation } from '../src/positions/monitor.ts';
import { reconcileConfirmedSell, type ConfirmedSellFill } from '../src/positions/reconcile.ts';
import { SimulationSellGuard } from '../src/risk/sell-guard.ts';

const now = new Date('2026-10-02T12:00:00.000Z');
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const quoteMint = 'So11111111111111111111111111111111111111112';
const program = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const position: OpenPosition = {
  id: 'position-1', mint, walletId: 'fixture-wallet', status: 'OPEN',
  exitIntentId: null,
  quantityRaw: '2000000', costQuoteRaw: '100000000',
  peakValueQuoteRaw: '140000000', realizedPnlQuoteRaw: '0',
  openedAt: '2026-10-02T11:00:00.000Z',
  entrySignature: 'fixture-entry', version: 3
};
const observation: PositionObservation = {
  sourceKind: 'FIXTURE', sourceId: 'fixture-position-source',
  snapshotId: 'snapshot-1', positionId: position.id, positionVersion: position.version,
  market: marketAt(now.toISOString()), observedAt: now.toISOString(),
  markValueQuoteRaw: '120000000', liquidityQuoteRaw: '1000000000',
  devSellVerified: false, organicNetFlowRaw: '1000000',
  organicBuyerGrowthBps: 100, evidenceIds: ['fixture-position-evidence']
};
const exitPolicy: ExitPolicy = {
  stopLossBps: 2000, takeProfitBps: 5000, trailingStopBps: 2500,
  maxHoldMs: 2 * 60 * 60_000, minLiquidityQuoteRaw: '100000000'
};
const riskPolicy = {
  version: 'fixture-policy', quoteMint, minLiquidityQuoteRaw: '100000000',
  maxPositionQuoteRaw: '200000000', maxTotalExposureQuoteRaw: '500000000',
  maxDailyLossQuoteRaw: '100000000', maxConcurrentOrders: 2,
  maxOpenPositions: 3, maxSlippageBps: 500, maxPriceImpactBps: 200,
  maxFeeRaw: '10000', allowedProgramIds: [program]
};
const output = { action: 'REDUCE', reduceBps: 5000,
  rationale: 'Momentum weakening', evidenceIds: ['fixture-position-evidence'] };

function agent(result: unknown): ManagerAgent {
  return new LlmManagerAgent({ completeJson: async () => result }, 'mock-manager-v1', () => now);
}
function journal() {
  const entries: unknown[] = [];
  const port: PositionJournal = { append: async (proposal, signal) => {
    entries.push({ proposal, signal });
  } };
  return { entries, port };
}
function proposal(action: 'EXIT' | 'REDUCE' = 'EXIT'): PositionProposal {
  return {
    positionId: position.id, positionVersion: position.version,
    snapshotId: observation.snapshotId, action,
    reduceBps: action === 'REDUCE' ? 5000 : null,
    rationale: 'fixture-decision', evidenceIds: observation.evidenceIds,
    modelVersion: 'deterministic-1', promptVersion: 'none',
    createdAt: now.toISOString(), expiresAt: '2026-10-02T12:01:00.000Z'
  };
}
function request(amountRaw = position.quantityRaw): DryRunTradeRequest {
  return {
    intent: { id: 'sell-intent-1', side: 'SELL', mint,
      amountRaw, minOutputRaw: '95000000', maxFeeRaw: '6000',
      maxSlippageBps: 500, policyVersion: riskPolicy.version,
      expiresAt: '2026-10-02T12:01:00.000Z' },
    quoteRequest: { id: 'sell-quote-1', poolId: POOL,
      inputMint: mint, outputMint: quoteMint, amountInRaw: amountRaw,
      maxSlippageBps: 500, requestedAt: now.toISOString() },
    venue: 'raydium-cpmm', walletId: position.walletId
  };
}
function adapter(trade: DryRunTradeRequest, balanceRaw = position.quantityRaw) {
  return new FnzeroDryRunAdapter([{ request: trade.quoteRequest, result: {
    requestId: trade.quoteRequest.id, expectedOutputRaw: '100000000',
    minOutputRaw: '95000000', estimatedFeeRaw: '5000',
    priceImpactBps: 100, observedAt: now.toISOString(),
    expiresAt: '2026-10-02T12:01:00.000Z', evidenceIds: ['fixture-sell-quote']
  } }], [{ walletId: position.walletId, mint, amountRaw: balanceRaw,
    observedAt: now.toISOString(), sourceId: 'fixture-token-balance' }], () => now);
}

test('deterministic exits take precedence over the LLM', async () => {
  const cases: [string, PositionObservation, Date, OpenPosition?][] = [
    ['STOP_LOSS', { ...observation, markValueQuoteRaw: '79000000' }, now],
    ['TAKE_PROFIT', { ...observation, markValueQuoteRaw: '151000000' }, now],
    ['TRAILING_STOP', { ...observation, markValueQuoteRaw: '104000000' }, now],
    ['VERIFIED_DEV_SELL', { ...observation, devSellVerified: true }, now],
    ['LIQUIDITY_COLLAPSE', { ...observation, liquidityQuoteRaw: '99999999' }, now],
    ['MAX_HOLD', observation, now,
      { ...position, openedAt: '2026-10-02T10:00:00.000Z' }]
  ];
  for (const [reason, observed, at, held = position] of cases) {
    let called = 0;
    const log = journal();
    const result = await reviewPosition(held, observed, exitPolicy,
      { propose: async () => { called++; throw new Error('should not run'); } },
      log.port, () => at);
    assert.equal(result.proposal.action, 'EXIT', reason);
    assert.ok(result.signal.reasons.includes(reason), reason);
    assert.equal(called, 0, reason);
    assert.equal(log.entries.length, 1);
  }
});

test('missing critical facts fail closed and do not invoke the model', async () => {
  let called = 0;
  const result = await reviewPosition(position, { ...observation,
    devSellVerified: null }, exitPolicy,
  { propose: async () => { called++; throw new Error('should not run'); } },
  journal().port, () => now);
  assert.equal(result.signal.status, 'UNKNOWN');
  assert.equal(result.proposal.action, 'HOLD');
  assert.equal(called, 0);
});

test('max-hold alert survives stale market data but cannot reach SELL guard', async () => {
  const aged = { ...position, openedAt: '2026-10-02T09:00:00.000Z' };
  const later = new Date('2026-10-02T13:00:00.000Z');
  const review = await reviewPosition(aged, observation, exitPolicy,
    { propose: async () => { throw new Error('should not run'); } },
    journal().port, () => later);
  assert.equal(review.proposal.action, 'EXIT');
  assert.ok(review.signal.reasons.includes('MAX_HOLD'));
  const trade = request();
  const blocked = await simulateGuardedSell(trade, aged, observation,
    review.proposal, [program], new SimulationSellGuard(riskPolicy),
    adapter(trade), () => later);
  assert.equal(blocked.guard.status, 'BLOCKED');
  assert.equal(blocked.preview, null);
});

test('manager sees bounded facts and returns a version-bound advisory proposal', async () => {
  const extra = { ...position, privateKey: 'never-send', walletId: 'hidden-wallet' };
  const messages = buildManagerMessages(extra, observation);
  assert.equal(messages[1].content.includes('never-send'), false);
  assert.equal(messages[1].content.includes('hidden-wallet'), false);
  const result = await reviewPosition(position, observation, exitPolicy,
    agent(output), journal().port, () => now);
  assert.equal(result.signal.status, 'NONE');
  assert.equal(result.proposal.action, 'REDUCE');
  assert.equal(result.proposal.reduceBps, 5000);
  assert.equal(result.proposal.positionVersion, 3);
  assert.equal(result.proposal.snapshotId, 'snapshot-1');
});

test('manager rejects fabricated evidence, tool-like fields, stale versions and timeout', async () => {
  for (const invalid of [
    { ...output, evidenceIds: ['fabricated'] },
    { ...output, authorization: 'sell-now' },
    { ...output, reduceBps: 10_000 },
    { ...output, rationale: 'act\nnow' }
  ]) {
    const result = await reviewPosition(position, observation, exitPolicy,
      agent(invalid), journal().port, () => now);
    assert.equal(result.proposal.action, 'HOLD');
    assert.equal(result.proposal.rationale, 'INVALID_AGENT_PROPOSAL');
  }
  const stale: ManagerAgent = { propose: async () => ({ ...proposal(),
    positionVersion: 2 }) };
  assert.equal((await reviewPosition(position, observation, exitPolicy,
    stale, journal().port, () => now)).proposal.action, 'HOLD');
  let abort: AbortSignal | undefined;
  const never: ManagerAgent = { propose: async (_p, _o, signal) => {
    abort = signal;
    return new Promise(() => {});
  } };
  const timeout = await reviewPosition(position, observation, exitPolicy,
    never, journal().port, () => now, 10);
  assert.equal(timeout.proposal.rationale, 'AGENT_TIMEOUT');
  assert.equal(abort?.aborted, true);
});

test('a hard exit arising during model latency overrides HOLD', async () => {
  let tick = 0;
  const nearExpiry = { ...position, openedAt: '2026-10-02T10:00:01.000Z' };
  const result = await reviewPosition(nearExpiry, observation, exitPolicy,
    agent({ action: 'HOLD', reduceBps: null, rationale: 'wait', evidenceIds: [] }),
    journal().port, () => new Date(now.getTime() + tick++ * 1000));
  assert.equal(result.proposal.action, 'EXIT');
  assert.ok(result.signal.reasons.includes('MAX_HOLD'));
});

test('SELL guard previews one checked quote; duplicate and stale position attempts block', async () => {
  const trade = request();
  const guard = new SimulationSellGuard(riskPolicy);
  const result = await simulateGuardedSell(trade, position, observation,
    proposal(), [program], guard, adapter(trade), () => now);
  assert.equal(result.guard.status, 'SIMULATION_ALLOWED', JSON.stringify(result.guard.reasons));
  assert.equal(result.preview?.side, 'SELL');
  assert.deepEqual(result.preview?.signatures, []);
  assert.equal(result.exitReviewStatus, 'PREVIEWED');
  const base = adapter(trade);
  const sanitized = await simulateGuardedSell(trade, position, observation,
    proposal(), [program], new SimulationSellGuard(riskPolicy), {
      quote: async (item) => {
        const quoted = await base.quote(item);
        return quoted ? { ...quoted, privateKey: 'should-not-leak' } : null;
      },
      getBalance: (wallet, token) => base.getBalance(wallet, token),
      buy: (item, facts) => base.buy(item, facts),
      sell: (item, facts) => {
        assert.equal('privateKey' in (facts.quote ?? {}), false);
        const preview = base.sell(item, facts);
        return preview ? { ...preview, privateKey: 'should-not-leak' } : null;
      }
    }, () => now);
  assert.equal(JSON.stringify(sanitized.preview).includes('should-not-leak'), false);
  assert.equal((await simulateGuardedSell(trade, position, observation,
    proposal(), [program], guard, adapter(trade), () => now)).guard.status, 'BLOCKED');
  const stale = await simulateGuardedSell(trade, { ...position, version: 4 },
    observation, proposal(), [program], new SimulationSellGuard(riskPolicy),
    adapter(trade), () => now);
  assert.equal(stale.guard.status, 'BLOCKED');
});

test('missing route and partial balance retain unresolved position; invalid route blocks', async () => {
  const trade = request();
  const noRoute = new FnzeroDryRunAdapter([], [{ walletId: position.walletId,
    mint, amountRaw: position.quantityRaw, observedAt: now.toISOString(),
    sourceId: 'fixture-token-balance' }], () => now);
  const missing = await simulateGuardedSell(trade, position, observation,
    proposal(), [program], new SimulationSellGuard(riskPolicy), noRoute, () => now);
  assert.equal(missing.guard.status, 'BLOCKED');
  assert.equal(missing.exitReviewStatus, 'UNRESOLVED');
  const partial = await simulateGuardedSell(trade, position, observation,
    proposal(), [program], new SimulationSellGuard(riskPolicy),
    adapter(trade, '1000000'), () => now);
  assert.equal(partial.guard.status, 'BLOCKED');
  assert.equal(partial.exitReviewStatus, 'UNRESOLVED');
  assert.equal(position.status, 'OPEN');
  const badRoute = await simulateGuardedSell({ ...trade, quoteRequest: {
    ...trade.quoteRequest, poolId: quoteMint } }, position, observation,
  proposal(), [program], new SimulationSellGuard(riskPolicy), adapter(trade), () => now);
  assert.equal(badRoute.guard.status, 'BLOCKED');
});

test('REDUCE amount is bound to proposal basis points', async () => {
  const trade = request('1000000');
  const valid = await simulateGuardedSell(trade, position, observation,
    proposal('REDUCE'), [program], new SimulationSellGuard(riskPolicy),
    adapter(trade), () => now);
  assert.equal(valid.guard.status, 'SIMULATION_ALLOWED', JSON.stringify(valid.guard.reasons));
  const oversized = await simulateGuardedSell(request(), position, observation,
    proposal('REDUCE'), [program], new SimulationSellGuard(riskPolicy),
    adapter(request()), () => now);
  assert.equal(oversized.guard.status, 'BLOCKED');
});

test('only confirmed fixture fills may reduce quantity or close a position', () => {
  const pending: OpenPosition = { ...position, status: 'EXIT_PENDING',
    exitIntentId: 'sell-intent-1' };
  const partial: ConfirmedSellFill = {
    sourceKind: 'FIXTURE', sourceId: 'fixture-reconciliation',
    positionId: position.id, positionVersion: 3,
    intentId: 'sell-intent-1', signature: '1'.repeat(64),
    filledQuantityRaw: '1000000', proceedsQuoteRaw: '60000000',
    feeQuoteRaw: '0', balanceAfterRaw: '1000000',
    confirmedAt: now.toISOString(), evidenceIds: ['confirmed-balance']
  };
  assert.throws(() => reconcileConfirmedSell(position, partial, now));
  assert.throws(() => reconcileConfirmedSell(pending, {
    ...partial, balanceAfterRaw: '0'
  }, now));
  assert.throws(() => reconcileConfirmedSell(pending, {
    ...partial, sourceKind: 'UNVERIFIED' as 'FIXTURE'
  }, now));
  assert.throws(() => reconcileConfirmedSell(pending, {
    ...partial, intentId: 'another-order'
  }, now));
  const first = reconcileConfirmedSell(pending, partial, now);
  assert.equal(first.closedTrade, null);
  assert.equal(first.remaining?.quantityRaw, '1000000');
  assert.equal(first.remaining?.costQuoteRaw, '50000000');
  assert.equal(first.remaining?.peakValueQuoteRaw, '70000000');
  assert.equal(first.remaining?.realizedPnlQuoteRaw, '10000000');
  assert.equal(first.remaining?.status, 'OPEN');
  assert.equal(first.remaining?.version, 4);
  assert.throws(() => reconcileConfirmedSell({ ...first.remaining!, status: 'EXIT_PENDING',
    exitIntentId: 'sell-intent-2' },
    partial, now));
  const final = reconcileConfirmedSell({ ...first.remaining!, status: 'UNRESOLVED',
    exitIntentId: 'sell-intent-2' }, {
    ...partial, positionVersion: 4, filledQuantityRaw: '1000000',
    intentId: 'sell-intent-2',
    proceedsQuoteRaw: '40000000', balanceAfterRaw: '0',
    evidenceIds: ['confirmed-final-balance']
  }, now);
  assert.equal(final.remaining, null);
  assert.equal(final.closedTrade?.reconciled, true);
  assert.equal(final.closedTrade?.realizedPnlQuoteRaw, '0');
});
