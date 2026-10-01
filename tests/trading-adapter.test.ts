import { POOL } from './helpers/market.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { DryRunTradeRequest } from '../src/application/trading-adapter.ts';
import { FnzeroDryRunAdapter, previewFnzeroMapping } from '../src/execution/fnzero/dry-run.ts';
import { normalizeFnzeroTradeResult } from '../src/execution/fnzero/result.ts';

const now = new Date('2026-09-28T12:00:00.000Z');
const wsol = 'So11111111111111111111111111111111111111112';
const token = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const walletId = 'paper-wallet-1';
const buyQuoteRequest = {
  id: 'quote-buy-1', poolId: POOL, inputMint: wsol, outputMint: token,
  amountInRaw: '100000000', maxSlippageBps: 500, requestedAt: now.toISOString()
};
const buyQuote = {
  requestId: buyQuoteRequest.id, expectedOutputRaw: '2000000',
  minOutputRaw: '1900000', estimatedFeeRaw: '5000', priceImpactBps: 100,
  observedAt: now.toISOString(), expiresAt: '2026-09-28T12:01:00.000Z',
  evidenceIds: ['fixture-quote-buy']
};
const sellQuoteRequest = {
  id: 'quote-sell-1', poolId: POOL, inputMint: token, outputMint: wsol,
  amountInRaw: '2000000', maxSlippageBps: 500, requestedAt: now.toISOString()
};
const sellQuote = {
  requestId: sellQuoteRequest.id, expectedOutputRaw: '100000000',
  minOutputRaw: '95000000', estimatedFeeRaw: '5000', priceImpactBps: 100,
  observedAt: now.toISOString(), expiresAt: '2026-09-28T12:01:00.000Z',
  evidenceIds: ['fixture-quote-sell']
};
const buyRequest: DryRunTradeRequest = {
  intent: {
    id: 'intent-buy-1', side: 'BUY', mint: token, amountRaw: '100000000',
    minOutputRaw: '1800000', maxFeeRaw: '6000', maxSlippageBps: 500,
    policyVersion: 'fixture-policy-1', expiresAt: '2026-09-28T12:01:00.000Z'
  },
  quoteRequest: buyQuoteRequest, venue: 'pumpswap', walletId
};
const sellRequest: DryRunTradeRequest = {
  intent: {
    id: 'intent-sell-1', side: 'SELL', mint: token, amountRaw: '2000000',
    minOutputRaw: '90000000', maxFeeRaw: '6000', maxSlippageBps: 500,
    policyVersion: 'fixture-policy-1', expiresAt: '2026-09-28T12:01:00.000Z'
  },
  quoteRequest: sellQuoteRequest, venue: 'raydium-cpmm', walletId
};
const quotes = [
  { request: buyQuoteRequest, result: buyQuote },
  { request: sellQuoteRequest, result: sellQuote }
];
const balances = [
  { walletId, mint: wsol, amountRaw: '200000000', observedAt: now.toISOString(),
    sourceId: 'fixture-balance' },
  { walletId, mint: token, amountRaw: '3000000', observedAt: now.toISOString(),
    sourceId: 'fixture-balance' }
];
async function previewBuy(adapter: FnzeroDryRunAdapter, request: DryRunTradeRequest) {
  return adapter.buy(request, { quote: await adapter.quote(request.quoteRequest),
    balance: await adapter.getBalance(request.walletId, request.quoteRequest.inputMint) });
}
const adapter = () => new FnzeroDryRunAdapter(quotes, balances, () => now);

test('buy and sell produce inert previews with separate quote and balance fixtures', async () => {
  const dryRun = adapter();
  assert.equal((await dryRun.quote(buyQuoteRequest))?.requestId, 'quote-buy-1');
  assert.equal((await dryRun.getBalance(walletId, wsol))?.amountRaw, '200000000');
  const buy = await previewBuy(dryRun, buyRequest);
  const sell = dryRun.sell(sellRequest, { quote: sellQuote, balance: balances[1] });
  assert.equal(buy?.status, 'SIMULATED');
  assert.equal(buy?.mode, 'DRY_RUN');
  assert.equal(buy?.side, 'BUY');
  assert.deepEqual(buy?.signatures, []);
  assert.equal(sell?.status, 'SIMULATED');
  assert.equal(sell?.side, 'SELL');
  assert.deepEqual(sell?.signatures, []);
  assert.equal('inputFilledRaw' in (buy ?? {}), false);
});

test('FnZero preview maps supported venue and rejects unsafe number conversion', () => {
  assert.deepEqual(previewFnzeroMapping(buyRequest), {
    method: 'buy', dexType: 'PumpSwap', mint: token,
    inputTokenAmount: 100000000, slippageBasisPoints: 500,
    missingForExecution: ['quoteTokenType', 'extensionParams', 'recentBlockhash', 'signer',
      'finalInstructionValidation']
  });
  assert.equal(previewFnzeroMapping(sellRequest).dexType, 'RaydiumCpmm');
  assert.throws(() => previewFnzeroMapping({
    ...buyRequest, intent: { ...buyRequest.intent, amountRaw: '9007199254740993' }
  }));
});

test('missing, stale, mismatched, or over-budget facts fail closed', async () => {
  const dryRun = adapter();
  assert.equal(await previewBuy(dryRun, { ...buyRequest, intent: {
    ...buyRequest.intent, side: 'SELL'
  } }), null);
  assert.equal(await previewBuy(dryRun, { ...buyRequest, quoteRequest: {
    ...buyQuoteRequest, outputMint: wsol
  } }), null);
  assert.equal(await previewBuy(dryRun, { ...buyRequest, intent: {
    ...buyRequest.intent, maxFeeRaw: '4999'
  } }), null);
  assert.equal(await previewBuy(dryRun, { ...buyRequest, intent: {
    ...buyRequest.intent, maxFeeRaw: '9'.repeat(1000)
  } }), null);
  assert.equal(await previewBuy(dryRun, { ...buyRequest, intent: {
    ...buyRequest.intent, minOutputRaw: '1900001'
  } }), null);
  assert.equal(await previewBuy(new FnzeroDryRunAdapter(quotes, balances.map((item) =>
    item.mint === wsol ? { ...item, amountRaw: '99999999' } : item), () => now), buyRequest), null);
  assert.equal(await previewBuy(new FnzeroDryRunAdapter(quotes, balances,
    () => new Date('2026-09-28T12:02:00.000Z')), buyRequest), null);
  assert.equal(await new FnzeroDryRunAdapter([quotes[0], quotes[0]], balances,
    () => now).quote(buyQuoteRequest), null);
});

test('provider extras cannot leak and dry-run has no SDK or network execution path', async () => {
  const withExtra = new FnzeroDryRunAdapter([
    { request: buyQuoteRequest, result: {
      ...buyQuote, privateKey: 'should-not-leak'
    } as typeof buyQuote }
  ], balances, () => now);
  const quote = await withExtra.quote(buyQuoteRequest);
  assert.equal(JSON.stringify(quote).includes('should-not-leak'), false);
  const source = await readFile(new URL('../src/execution/fnzero/dry-run.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|Keypair|sendTransaction|sendRawTransaction|signTransaction)\s*\(/);
  assert.doesNotMatch(source, /from\s*['"](?:sol-trade-sdk|@solana\/web3\.js)/);
});

test('SDK receipt shape never becomes a confirmed fill or a retryable failure', () => {
  const signature = '1'.repeat(64);
  const submitted = normalizeFnzeroTradeResult('intent-buy-1', {
    success: true, signatures: [signature], timings: []
  });
  assert.equal(submitted.status, 'SUBMITTED');
  assert.deepEqual(submitted.signatures, [signature]);
  assert.equal(submitted.confirmedAt, null);
  assert.equal(submitted.outputFilledRaw, null);
  const ambiguous = normalizeFnzeroTradeResult('intent-buy-1', {
    success: false, signatures: [signature], error: { privateKey: 'should-not-leak' }
  });
  assert.equal(ambiguous.status, 'UNKNOWN');
  assert.deepEqual(ambiguous.signatures, [signature]);
  assert.equal(JSON.stringify(ambiguous).includes('should-not-leak'), false);
  assert.equal(normalizeFnzeroTradeResult('intent-buy-1', {
    success: true, signatures: [signature], simulation: { logs: [] }
  }).status, 'UNKNOWN');
  assert.equal(normalizeFnzeroTradeResult('intent-buy-1', {
    success: true, signatures: ['invalid']
  }).status, 'UNKNOWN');
});
