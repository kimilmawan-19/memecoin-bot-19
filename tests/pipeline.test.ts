import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DiscoveryIndex } from '../src/discovery/events.ts';
import { parseDiscoveryTransaction, PUMPSWAP_PROGRAM } from '../src/discovery/parse-transaction.ts';
import { FixtureFeatureProvider } from '../src/providers/feature-fixture.ts';
import { FixtureObservationProvider } from '../src/providers/fixture.ts';
import { collectIntelligence, type ObservationProvider } from '../src/intelligence/collect.ts';
import { fixtureRiskPolicy } from '../src/screening/fixture-risk.ts';
import { LlmScreenerAgent } from '../src/agents/screener/agent.ts';
import { evaluateCandidate } from '../src/application/evaluate.ts';
import { simulateGuardedBuy } from '../src/application/simulate.ts';
import { FnzeroDryRunAdapter } from '../src/execution/fnzero/dry-run.ts';
import { SimulationExecutionGuard } from '../src/risk/guard.ts';
import type { ScreenerProposal, ExecutionIntent } from '../src/core/models.ts';

// Recorded discovery is combined with synthetic intelligence/risk/execution facts.
// This proves module contracts, not historical profitability or on-chain safety.
test('offline discovery, features, risk, LLM, journal and guarded preview share one pipeline', async () => {
  const recorded = JSON.parse(await readFile(new URL('../fixtures/phase4-onchain.json', import.meta.url), 'utf8'));
  const item = recorded.cases[0];
  const instructions = Array.from({ length: item.outerIndex + 1 }, () => ({}));
  instructions[item.outerIndex] = item.instruction;
  const events = parseDiscoveryTransaction({ slot: item.slot, blockTime: item.blockTime, meta: { err: null },
    transaction: { signatures: [item.signature], message: { instructions } } }, item.signature);
  const candidate = new DiscoveryIndex().ingest(events).candidates[0];
  const raw = JSON.parse(await readFile(new URL('../fixtures/features.json', import.meta.url), 'utf8'));
  const provider = new FixtureFeatureProvider(raw);
  const frame = raw.frames[0];
  const at = frame.observedAt;
  const now = new Date(at);
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const config = {
    version: 'integration-v1', quoteMint: frame.quoteMint, minLiquidityQuoteRaw: '100',
    maxPositionQuoteRaw: '200', maxTotalExposureQuoteRaw: '500', maxDailyLossQuoteRaw: '100',
    maxConcurrentOrders: 2, maxOpenPositions: 3, maxSlippageBps: 500, maxPriceImpactBps: 200,
    maxFeeRaw: '10', allowedProgramIds: [PUMPSWAP_PROGRAM]
  };
  const tokenFacts = { candidateId: candidate.id, mint: candidate.mint, quoteMint: frame.quoteMint,
    quoteDecimals: frame.quoteDecimals, poolId: frame.poolId, sourceKind: 'FIXTURE' as const,
    sourceId: 'synthetic-risk', observedAt: at, mintAuthorityRevoked: true, freezeAuthorityRevoked: true,
    tokenProgramSupported: true, poolVaultVerified: true, supplyVerified: true, liquidityQuoteRaw: '1000' };
  const quoteRequest = { id: 'quote', poolId: frame.poolId, inputMint: frame.quoteMint,
    outputMint: candidate.mint, amountInRaw: '100', maxSlippageBps: 500, requestedAt: at };
  const quote = { requestId: quoteRequest.id, expectedOutputRaw: '100',
    minOutputRaw: '95', estimatedFeeRaw: '5', priceImpactBps: 100, observedAt: at, expiresAt,
    evidenceIds: ['synthetic-quote'] };
  const balance = { walletId: 'paper', mint: frame.quoteMint, amountRaw: '200',
    observedAt: at, sourceId: 'synthetic-balance' };
  const intent: ExecutionIntent = { id: 'intent', side: 'BUY', mint: candidate.mint,
    amountRaw: '100', minOutputRaw: '95', maxFeeRaw: '10', maxSlippageBps: 500,
    policyVersion: config.version, expiresAt };
  for (const scenario of ['buy', 'skip', 'conflict', 'timeout', 'kill-switch', 'quote-mismatch']) {
    const providers: ObservationProvider[] = [provider];
    if (scenario === 'conflict') {
      const first = (await provider.observe(candidate))[0];
      providers.push(new FixtureObservationProvider({ version: 1, observations: [{
        ...first, sourceId: 'fixture', evidenceId: 'mixed-pool',
        market: { ...first.market, poolId: '11111111111111111111111111111111' }
      }] }));
    }
    const intelligence = await collectIntelligence(candidate, providers, now);
    let modelCalls = 0;
    let buyCalls = 0;
    const agent = new LlmScreenerAgent({ completeJson: async (messages) => {
      modelCalls++;
      const payload = JSON.parse(messages[1].content).data;
      assert.equal(payload.market.quoteMint, frame.quoteMint);
      assert.equal(payload.market.quoteDecimals, frame.quoteDecimals);
      if (scenario === 'timeout') return new Promise(() => {});
      return { action: scenario === 'skip' ? 'SKIP' : 'BUY', rationale: 'Synthetic contract test',
        risks: [], evidenceIds: [payload.evidenceIds[0]] };
    } }, 'mock', () => now);
    const log: ScreenerProposal[] = [];
    const evaluation = await evaluateCandidate(candidate, intelligence,
      fixtureRiskPolicy(tokenFacts, config, () => now), agent,
      { append: async (proposal) => { log.push(proposal); } }, () => now, 10);
    assert.equal(log.length, 1);
    const adapter = new FnzeroDryRunAdapter([{ request: quoteRequest, result: quote }], [balance], () => now);
    const request = { intent, quoteRequest: scenario === 'quote-mismatch'
      ? { ...quoteRequest, poolId: '11111111111111111111111111111111' } : quoteRequest,
      walletId: 'paper', venue: 'pumpswap' as const };
    const portfolio = { walletId: 'paper', quoteMint: frame.quoteMint, observedAt: at,
      sourceId: 'synthetic-portfolio', killSwitch: scenario === 'kill-switch',
      dailyLossQuoteRaw: '0', totalExposureQuoteRaw: '0', pendingExposureQuoteRaw: '0',
      exposureByMint: {}, openPositionCount: 0, activeOrderCount: 0, unresolvedOrderCount: 0 };
    const result = evaluation.proposal.action === 'BUY' ? await simulateGuardedBuy(request,
      candidate, intelligence, tokenFacts, portfolio, evaluation.proposal, [PUMPSWAP_PROGRAM],
      new SimulationExecutionGuard(config), {
        quote: (item) => adapter.quote(item),
        getBalance: (wallet, mint) => adapter.getBalance(wallet, mint),
        buy: (item, facts) => { buyCalls++; return adapter.buy(item, facts); },
        sell: (item, facts) => adapter.sell(item, facts)
      }, () => now) : null;
    assert.equal(modelCalls, scenario === 'conflict' ? 0 : 1);
    assert.equal(buyCalls, scenario === 'buy' ? 1 : 0);
    if (scenario === 'buy') {
      assert.equal(result?.guard.status, 'SIMULATION_ALLOWED');
      assert.equal(result?.preview?.status, 'SIMULATED');
      assert.deepEqual(result?.preview?.signatures, []);
    } else {
      assert.equal(result?.preview ?? null, null);
    }
  }
});
