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
  candidateId: candidate.id, sourceId: 'fixture', evidenceId: 'observation-1',
  observedAt: at, coverageBps: 10_000, confidenceBps: 10_000,
  metrics: { liquidity: { liquidityQuoteRaw: '1000000000' } }
}], now);
const tokenFacts: TokenRiskFacts = {
  candidateId: candidate.id, mint, quoteMint, sourceKind: 'FIXTURE' as const,
  sourceId: 'fixture-token-facts', observedAt: at,
  mintAuthorityRevoked: true, freezeAuthorityRevoked: true,
  tokenProgramSupported: true, poolVaultVerified: true, supplyVerified: true,
  liquidityQuoteRaw: '1000000000'
};
const portfolio: PortfolioSnapshot = {
  walletId: 'paper-wallet', quoteMint, observedAt: at, sourceId: 'fixture-portfolio',
  killSwitch: false, dailyLossQuoteRaw: '0', totalExposureQuoteRaw: '100000000',
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
  id: 'quote-1', inputMint: quoteMint, outputMint: mint,
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
    assessPortfolioRisk(snapshot, portfolio.walletId, amount, policy, now);
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
    portfolio, proposal, [program], guard, adapter, now);
  assert.equal(allowed.guard.status, 'SIMULATION_ALLOWED');
  assert.equal(allowed.preview?.status, 'SIMULATED');
  assert.deepEqual(allowed.preview?.signatures, []);
  const repeated = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts,
    portfolio, proposal, [program], guard, adapter, now);
  assert.equal(repeated.guard.status, 'BLOCKED');
  assert.equal(repeated.preview, null);
  const killed = await simulateGuardedBuy(request, candidate, intelligence, tokenFacts,
    { ...portfolio, killSwitch: true }, proposal, [program], new SimulationExecutionGuard(policy),
    {
      quote: (item) => adapter.quote(item),
      getBalance: (wallet, tokenMint) => adapter.getBalance(wallet, tokenMint),
      buy: async () => { throw new Error('blocked buy reached adapter'); },
      sell: (item) => adapter.sell(item)
    }, now);
  assert.equal(killed.guard.status, 'BLOCKED');
  assert.equal(killed.preview, null);
  const source = await readFile(new URL('../src/application/simulate.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:sendTransaction|signTransaction|Keypair|privateKey)\b/);
});
