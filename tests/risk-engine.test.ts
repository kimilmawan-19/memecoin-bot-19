import { marketAt, POOL } from './helpers/market.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { simulateGuardedBuy } from '../src/application/simulate.ts';
import type { DryRunTradeRequest } from '../src/application/trading-adapter.ts';
import type { ExecutionIntent, QuoteResult, ScreenerProposal, TokenCandidate } from '../src/core/models.ts';
import { FnzeroDryRunAdapter } from '../src/execution/fnzero/dry-run.ts';
import { normalizeIntelligence } from '../src/intelligence/normalize.ts';
import { SimulationExecutionGuard, type SimulationGuardInput } from '../src/risk/guard.ts';
import { assessPortfolioRisk, type PortfolioSnapshot } from '../src/risk/portfolio.ts';
import { parseRiskPolicy } from '../src/risk/policy.ts';
import { assessTokenRisk, type TokenRiskFacts } from '../src/risk/token.ts';

const now = new Date('2026-09-29T00:00:00.000Z');
const at = now.toISOString();
const expires = '2026-09-29T00:01:00.000Z';
const quoteMint = 'So11111111111111111111111111111111111111112';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const program = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const policy = parseRiskPolicy({
  version: 'test-v1', quoteMint, minLiquidityQuoteRaw: '100000000',
  maxPositionQuoteRaw: '200000000', maxTotalExposureQuoteRaw: '500000000',
  maxDailyLossQuoteRaw: '100000000', maxConcurrentOrders: 2, maxOpenPositions: 3,
  maxSlippageBps: 500, maxPriceImpactBps: 200, maxFeeRaw: '10000',
  allowedProgramIds: [program]
});
const candidate: TokenCandidate = {
  id: 'candidate-1', chain: 'solana', mint, discoveredAt: at,
  sourceId: 'fixture-candidate', evidenceIds: ['fixture-candidate']
};
const intelligence = normalizeIntelligence(candidate, [{
  market: marketAt(at),
  candidateId: candidate.id, sourceId: 'fixture', evidenceId: 'observation-1',
  observedAt: at, coverageBps: 10_000, confidenceBps: 10_000,
  metrics: { liquidity: { liquidityQuoteRaw: '1000000000' } }
}], now);
const tokenFacts: TokenRiskFacts = {
  candidateId: candidate.id, mint, quoteMint, sourceKind: 'FIXTURE' as const,
  sourceId: 'fixture-token-facts', observedAt: at, poolId: POOL, quoteDecimals: 9,
  mintAuthorityRevoked: true, freezeAuthorityRevoked: true,
  tokenProgramSupported: true, poolVaultVerified: true, supplyVerified: true,
  liquidityQuoteRaw: '1000000000'
};
const portfolio: PortfolioSnapshot = {
  walletId: 'paper-wallet', quoteMint, observedAt: at, sourceId: 'fixture-portfolio',
  killSwitch: false, dailyLossQuoteRaw: '0', totalExposureQuoteRaw: '100000000',
  exposureByMint: { [mint]: '100000000' },
  pendingExposureQuoteRaw: '0', openPositionCount: 1, activeOrderCount: 0,
  unresolvedOrderCount: 0
};
const proposal: ScreenerProposal = {
  candidateId: candidate.id, snapshotId: intelligence.snapshotId,
  action: 'BUY' as const, rationale: 'Fixture proposal', risks: [],
  evidenceIds: ['observation-1'], modelVersion: 'mock', promptVersion: 'mock',
  createdAt: at, expiresAt: expires
};
const quoteRequest = {
  id: 'quote-1', poolId: POOL, inputMint: quoteMint, outputMint: mint,
  amountInRaw: '100000000', maxSlippageBps: 500, requestedAt: at
};
const quote: QuoteResult = {
  requestId: quoteRequest.id, expectedOutputRaw: '2000000',
  minOutputRaw: '1900000', estimatedFeeRaw: '5000', priceImpactBps: 100,
  observedAt: at, expiresAt: expires, evidenceIds: ['fixture-quote']
};
const balance = { walletId: 'paper-wallet', mint: quoteMint, amountRaw: '200000000',
  observedAt: at, sourceId: 'fixture-balance' };
const intent: ExecutionIntent = {
  id: 'intent-1', side: 'BUY' as const, mint, amountRaw: '100000000',
  minOutputRaw: '1900000', maxFeeRaw: '6000', maxSlippageBps: 500,
  policyVersion: policy.version, expiresAt: expires
};
const input: SimulationGuardInput = { candidate, intelligence, tokenFacts, portfolio, proposal, intent,
  quoteRequest, quote, balance, walletId: portfolio.walletId,
  instructionProgramIds: [program] };

test('policy is strict, bounded, immutable and rejects unsafe limits', () => {
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.allowedProgramIds), true);
  assert.throws(() => parseRiskPolicy({ ...policy, privateKey: 'secret' }));
  assert.throws(() => parseRiskPolicy({ ...policy, maxPositionQuoteRaw: '600000000' }));
  assert.throws(() => parseRiskPolicy({ ...policy, maxFeeRaw: '-1' }));
  assert.throws(() => parseRiskPolicy({ ...policy, maxSlippageBps: 10_000 }));
  assert.throws(() => parseRiskPolicy({ ...policy, allowedProgramIds: [program, program] }));
});

test('token gate rejects unsafe facts and fails closed on missing, stale or conflicting facts', () => {
  assert.equal(assessTokenRisk(candidate, intelligence, tokenFacts, policy, now).status, 'PASS');
  assert.equal(assessTokenRisk(candidate, intelligence, {
    ...tokenFacts, mintAuthorityRevoked: false
  }, policy, now).status, 'REJECT');
  assert.equal(assessTokenRisk(candidate, intelligence, {
    ...tokenFacts, poolVaultVerified: false
  }, policy, now).status, 'REJECT');
  assert.equal(assessTokenRisk(candidate, intelligence, {
    ...tokenFacts, liquidityQuoteRaw: '99999999'
  }, policy, now).status, 'REJECT');
  for (const changed of [null, { ...tokenFacts, supplyVerified: null },
    { ...tokenFacts, observedAt: '2026-09-28T23:58:00.000Z' },
    { ...tokenFacts, quoteMint: mint }]) {
    assert.equal(assessTokenRisk(candidate, intelligence, changed, policy, now).status, 'UNKNOWN');
  }
  assert.equal(assessTokenRisk(candidate, {
    ...intelligence, conflictFields: ['liquidity.liquidityQuoteRaw']
  }, tokenFacts, policy, now).status, 'UNKNOWN');
});

test('portfolio gate enforces kill switch, loss, exposure, counts and unknown facts', () => {
  const check = (snapshot: PortfolioSnapshot | null, amount = '100000000') =>
    assessPortfolioRisk(snapshot, portfolio.walletId, mint, amount, policy, now);
  assert.equal(check(portfolio).status, 'PASS');
  for (const changed of [
    { ...portfolio, killSwitch: true },
    { ...portfolio, dailyLossQuoteRaw: '100000000' },
    { ...portfolio, pendingExposureQuoteRaw: '400000000' },
    { ...portfolio, openPositionCount: 3 },
    { ...portfolio, activeOrderCount: 2 },
    { ...portfolio, unresolvedOrderCount: 1 }
  ]) assert.equal(check(changed).status, 'REJECT');
  assert.equal(check(portfolio, '200000001').status, 'REJECT');
  assert.equal(check(null).status, 'UNKNOWN');
  assert.equal(check({ ...portfolio, killSwitch: null }).status, 'UNKNOWN');
  assert.equal(check({ ...portfolio, totalExposureQuoteRaw: null }).status, 'UNKNOWN');
  assert.equal(check({ ...portfolio, observedAt: '2026-09-28T23:59:00.000Z' }).status, 'UNKNOWN');
});

test('guard binds proposal, intent, quote, balance, policy and program manifest', () => {
  assert.equal(new SimulationExecutionGuard(policy).check(input, now).status, 'SIMULATION_ALLOWED');
  const blocked = (changes: Partial<SimulationGuardInput>) =>
    new SimulationExecutionGuard(policy).check({ ...input, ...changes }, now);
  assert.equal(blocked({ proposal: { ...proposal, action: 'SKIP' } }).status, 'BLOCKED');
  assert.equal(blocked({ proposal: { ...proposal, snapshotId: 'other' } }).status, 'BLOCKED');
  assert.equal(blocked({ proposal: { ...proposal, evidenceIds: ['fabricated'] } }).status, 'BLOCKED');
  assert.equal(blocked({ tokenFacts: null }).status, 'BLOCKED');
  assert.equal(blocked({ intent: { ...intent, side: 'SELL' } }).status, 'BLOCKED');
  assert.equal(blocked({ intent: { ...intent, policyVersion: 'other' } }).status, 'BLOCKED');
  assert.equal(blocked({ quoteRequest: { ...quoteRequest, amountInRaw: '1' } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: { ...quote, priceImpactBps: 201 } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: { ...quote, minOutputRaw: '1' } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: { ...quote, estimatedFeeRaw: '6001' } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: null }).status, 'BLOCKED');
  assert.equal(blocked({ balance: { ...balance, amountRaw: '99999999' } }).status, 'BLOCKED');
  assert.equal(blocked({ instructionProgramIds: ['UnknownProgram'] }).status, 'BLOCKED');
  assert.equal(blocked({ instructionProgramIds: [] }).status, 'BLOCKED');
  assert.equal(blocked({ intent: { ...intent, maxSlippageBps: 501 } }).status, 'BLOCKED');
  assert.equal(blocked({ intent: { ...intent, minOutputRaw: '1800000' } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: { ...quote, observedAt: '2026-09-28T23:59:00.000Z' } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: { ...quote, observedAt: '2026-09-29T00:00:01.000Z' } }).status, 'BLOCKED');
  assert.equal(blocked({ quote: { ...quote, expiresAt: 'not-a-time' } }).status, 'BLOCKED');
  assert.equal(blocked({ portfolio: { ...portfolio, killSwitch: true } }).status, 'BLOCKED');
  const secret = blocked({ intent: { ...intent, id: 'secret key must not appear' } });
  assert.equal(secret.intentId, null);
  assert.equal(JSON.stringify(secret).includes('secret key'), false);
});

test('single-process duplicate intent cannot get a second simulation allowance', () => {
  const guard = new SimulationExecutionGuard(policy);
  assert.equal(guard.check(input, now).status, 'SIMULATION_ALLOWED');
  const second = guard.check(input, now);
  assert.equal(second.status, 'BLOCKED');
  assert.ok(second.reasons.includes('DUPLICATE_INTENT'));
});

test('guarded application path previews only after passing risk and never signs', async () => {
  const request: DryRunTradeRequest = { intent, quoteRequest, walletId: portfolio.walletId,
    venue: 'pumpswap' };
  const adapter = new FnzeroDryRunAdapter([{ request: quoteRequest, result: quote }], [balance], () => now);
  const guard = new SimulationExecutionGuard(policy);
  const allowed = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts,
    portfolio, proposal, [program], guard, adapter, () => now);
  assert.equal(allowed.guard.status, 'SIMULATION_ALLOWED');
  assert.equal(allowed.preview?.status, 'SIMULATED');
  assert.deepEqual(allowed.preview?.signatures, []);
  const repeated = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts,
    portfolio, proposal, [program], guard, adapter, () => now);
  assert.equal(repeated.guard.status, 'BLOCKED');
  assert.equal(repeated.preview, null);
  const killed = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts,
    { ...portfolio, killSwitch: true }, proposal, [program], new SimulationExecutionGuard(policy),
    {
      quote: (item) => adapter.quote(item),
      getBalance: (wallet, tokenMint) => adapter.getBalance(wallet, tokenMint),
      buy: () => { throw new Error('blocked buy reached adapter'); },
      sell: (item, facts) => adapter.sell(item, facts)
    }, () => now);
  assert.equal(killed.guard.status, 'BLOCKED');
  assert.equal(killed.preview, null);
  const source = await readFile(new URL('../src/application/simulate.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:sendTransaction|signTransaction|Keypair|privateKey)\b/);
});

test('guarded preview uses the checked quote once even if provider facts change', async () => {
  const mutableQuotes = [{ request: quoteRequest, result: quote }];
  const adapter = new FnzeroDryRunAdapter(mutableQuotes, [balance], () => now);
  let quoteCalls = 0;
  const request: DryRunTradeRequest = { intent, quoteRequest, walletId: portfolio.walletId, venue: 'pumpswap' };
  const result = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts, portfolio,
    proposal, [program], new SimulationExecutionGuard(policy), {
      quote: async (item) => {
        quoteCalls++;
        const checked = await adapter.quote(item);
        mutableQuotes[0] = { request: quoteRequest, result: { ...quote, priceImpactBps: 9999 } };
        return checked;
      },
      getBalance: (wallet, mint) => adapter.getBalance(wallet, mint),
      buy: (item, facts) => {
        assert.equal(facts.quote?.priceImpactBps, 100);
        assert.ok(Object.isFrozen(item.intent));
        assert.ok(Object.isFrozen(facts.quote?.evidenceIds));
        return adapter.buy(item, facts);
      },
      sell: (item, facts) => adapter.sell(item, facts)
    }, () => now);
  assert.equal(quoteCalls, 1);
  assert.equal(result.preview?.status, 'SIMULATED');
  const blocked = new SimulationExecutionGuard(policy).check({
    ...input, quote: mutableQuotes[0].result
  }, now);
  assert.equal(blocked.status, 'BLOCKED');
});

test('latency cannot reuse the clock from before quote collection', async () => {
  let current = now;
  const adapter = new FnzeroDryRunAdapter([{ request: quoteRequest, result: quote }], [balance], () => current);
  let buys = 0;
  const result = await simulateGuardedBuy({ intent, quoteRequest, walletId: portfolio.walletId,
    venue: 'pumpswap' }, candidate, intelligence, tokenFacts, portfolio, proposal,
    [program], new SimulationExecutionGuard(policy), {
      quote: async (item) => {
        const result = await adapter.quote(item);
        current = new Date(now.getTime() + 20_000);
        return result;
      },
      getBalance: (wallet, mint) => adapter.getBalance(wallet, mint),
      buy: (item, facts) => { buys++; return adapter.buy(item, facts); },
      sell: (item, facts) => adapter.sell(item, facts)
    }, () => current);
  assert.equal(result.guard.status, 'BLOCKED');
  assert.ok(result.guard.reasons.includes('QUOTE_MISSING_OR_STALE'));
  assert.equal(buys, 0);
});

test('market identity and decimals bind intelligence, token facts and quote request', () => {
  for (const market of [
    null,
    { ...intelligence.market!, quoteMint: mint },
    { ...intelligence.market!, poolId: '11111111111111111111111111111111' },
    { ...intelligence.market!, quoteDecimals: 6 }
  ]) {
    const changed = { ...intelligence, market };
    const assessment = assessTokenRisk(candidate, changed, tokenFacts, policy, now);
    assert.equal(assessment.status, 'UNKNOWN');
    assert.equal(new SimulationExecutionGuard(policy).check({
      ...input, intelligence: changed
    }, now).status, 'BLOCKED');
  }
  assert.equal(new SimulationExecutionGuard(policy).check({ ...input,
    quoteRequest: { ...quoteRequest, poolId: '11111111111111111111111111111111' }
  }, now).status, 'BLOCKED');
});

test('distinct intents reserve position, total exposure, order slots and quote balance', () => {
  for (const scenario of [
    { overrides: {}, reasons: 'POSITION_LIMIT', available: balance.amountRaw, allowed: 1, attempts: 2 },
    { overrides: { maxPositionQuoteRaw: '500000000', maxConcurrentOrders: 100 },
      reasons: 'TOTAL_EXPOSURE_LIMIT', available: '1000000000', allowed: 4, attempts: 6 },
    { overrides: { maxPositionQuoteRaw: '500000000' },
      reasons: 'CONCURRENT_ORDER_LIMIT', available: '1000000000', allowed: 2, attempts: 3 },
    { overrides: { maxPositionQuoteRaw: '500000000', maxConcurrentOrders: 100 },
      reasons: 'BALANCE_MISSING_OR_STALE', available: '100000000', allowed: 1, attempts: 2 }
  ]) {
    const guard = new SimulationExecutionGuard({ ...policy, ...scenario.overrides });
    const results = Array.from({ length: scenario.attempts }, (_, i) => guard.check({
      ...input, intent: { ...intent, id: 'reserved-' + i },
      balance: { ...balance, amountRaw: scenario.available }
    }, now));
    assert.equal(results.filter((item) => item.status === 'SIMULATION_ALLOWED').length, scenario.allowed);
    assert.ok(results.at(-1)?.reasons.includes(scenario.reasons), scenario.reasons);
  }
  assert.equal(assessPortfolioRisk({ ...portfolio, exposureByMint: null },
    portfolio.walletId, mint, intent.amountRaw, policy, now).status, 'UNKNOWN');
  assert.equal(assessPortfolioRisk({ ...portfolio, exposureByMint: {} },
    portfolio.walletId, mint, intent.amountRaw, policy, now).status, 'UNKNOWN');
});

test('parallel previews reserve atomically and failures release capacity without reusing IDs', async () => {
  const adapter = new FnzeroDryRunAdapter([{ request: quoteRequest, result: quote }], [balance], () => now);
  const request: DryRunTradeRequest = { intent, quoteRequest, walletId: portfolio.walletId, venue: 'pumpswap' };
  const guard = new SimulationExecutionGuard(policy);
  const run = (id: string, target = adapter) => simulateGuardedBuy({
    ...request, intent: { ...intent, id }
  }, candidate, intelligence, tokenFacts, portfolio, proposal, [program], guard, target, () => now);
  const parallel = await Promise.all([run('parallel-1'), run('parallel-2')]);
  assert.equal(parallel.filter((item) => item.preview !== null).length, 1);
  for (const failure of ['null', 'throw', 'mismatch']) {
    const freshGuard = new SimulationExecutionGuard(policy);
    const bad = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts,
      portfolio, proposal, [program], freshGuard, {
        quote: (item) => adapter.quote(item),
        getBalance: (wallet, mint) => adapter.getBalance(wallet, mint),
        buy: (item, facts) => {
          if (failure === 'throw') throw new Error('private provider error');
          if (failure === 'null') return null;
          return { ...adapter.buy(item, facts)!, expectedOutputRaw: '1' };
        },
        sell: (item, facts) => adapter.sell(item, facts)
      }, () => now);
    assert.equal(bad.preview, null);
    assert.equal(JSON.stringify(bad).includes('private provider error'), false);
    assert.equal(freshGuard.check(input, now).status, 'BLOCKED');
    assert.equal(freshGuard.check({ ...input, intent: { ...intent, id: 'replacement' } }, now).status,
      'SIMULATION_ALLOWED');
  }
});

test('external pending mints consume position slots before a new simulation', () => {
  const pendingMint = '11111111111111111111111111111111';
  const pendingPortfolio: PortfolioSnapshot = {
    ...portfolio, totalExposureQuoteRaw: '0', pendingExposureQuoteRaw: '100000000',
    exposureByMint: { [pendingMint]: '100000000' }, openPositionCount: 0, activeOrderCount: 1
  };
  const result = new SimulationExecutionGuard({ ...policy, maxOpenPositions: 1 }).check({
    ...input, portfolio: pendingPortfolio
  }, now);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.reasons.includes('OPEN_POSITION_LIMIT'));

  // The pending mint and the new mint may fit exactly into two available slots.
  const fits = new SimulationExecutionGuard({ ...policy, maxOpenPositions: 2 }).check({
    ...input, portfolio: pendingPortfolio
  }, now);
  assert.equal(fits.status, 'SIMULATION_ALLOWED');
});

test('quote balance covers external pending exposure plus local reservations and the new buy', () => {
  const pendingPortfolio: PortfolioSnapshot = {
    ...portfolio, totalExposureQuoteRaw: '0', pendingExposureQuoteRaw: '100000000',
    exposureByMint: { [mint]: '100000000' }, openPositionCount: 0, activeOrderCount: 1
  };
  const changed = { ...input, portfolio: pendingPortfolio,
    balance: { ...balance, amountRaw: '199999999' } };
  const insufficient = new SimulationExecutionGuard(policy).check(changed, now);
  assert.equal(insufficient.status, 'BLOCKED');
  assert.ok(insufficient.reasons.includes('BALANCE_MISSING_OR_STALE'));

  const guard = new SimulationExecutionGuard({
    ...policy, maxPositionQuoteRaw: '500000000', maxConcurrentOrders: 3
  });
  assert.equal(guard.check({ ...changed, balance }, now).status, 'SIMULATION_ALLOWED');
  const second = guard.check({ ...changed, balance, intent: { ...intent, id: 'next-pending' } }, now);
  assert.equal(second.status, 'BLOCKED');
  assert.ok(second.reasons.includes('BALANCE_MISSING_OR_STALE'));

  // Committed exposure has already spent its quote balance; do not reserve it again.
  assert.equal(new SimulationExecutionGuard(policy).check({
    ...input, balance: { ...balance, amountRaw: intent.amountRaw }
  }, now).status, 'SIMULATION_ALLOWED');
});
