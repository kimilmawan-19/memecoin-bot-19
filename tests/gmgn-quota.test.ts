import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GmgnQueryGate, InMemoryWeightedQuota, RateLimited } from '../src/providers/gmgn/quota.ts';

const validate = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 20) throw new Error('Invalid schema');
  return value;
};

test('weighted quota is shared across gate instances and resets daily budget', async () => {
  let now = 0;
  const ledger = new InMemoryWeightedQuota(3, 3, 4);
  const first = new GmgnQueryGate(ledger, () => now);
  const second = new GmgnQueryGate(ledger, () => now);
  let calls = 0;
  const request = async () => { calls++; return 'ok'; };
  assert.equal(await first.query('route:a', 2, 100, request, validate), 'ok');
  assert.equal(await second.query('route:b', 2, 100, request, validate), null);
  now = 1000;
  assert.equal(await second.query('route:b', 2, 100, request, validate), 'ok');
  now = 2000;
  assert.equal(await first.query('route:c', 1, 100, request, validate), null);
  now = 86_400_000;
  assert.equal(await first.query('route:c', 1, 100, request, validate), 'ok');
  assert.equal(calls, 3);
});

test('cache and concurrent duplicate request spend quota once', async () => {
  let now = 0;
  const gate = new GmgnQueryGate(new InMemoryWeightedQuota(2, 1, 10), () => now);
  let calls = 0;
  const request = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return 'data'; };
  const [a, b] = await Promise.all([
    gate.query('mint:route', 2, 100, request, validate),
    gate.query('mint:route', 2, 100, request, validate)
  ]);
  assert.deepEqual([a, b], ['data', 'data']);
  assert.equal(calls, 1);
  assert.equal(await gate.query('mint:route', 2, 100, request, validate), 'data');
  assert.equal(calls, 1);
  now = 101;
  assert.equal(await gate.query('mint:route', 2, 100, request, validate), null);
});

test('429 cooldown, malformed data and timeout return no data or leaked error', async () => {
  let now = 0;
  const ledger = new InMemoryWeightedQuota(2, 2, 20);
  const gate = new GmgnQueryGate(ledger, () => now, 5);
  assert.equal(await gate.query('one', 1, 100, async () => {
    throw new RateLimited(3000);
  }, validate), null);
  now = 2000;
  assert.equal(await gate.query('two', 1, 100, async () => 'never', validate), null);
  now = 3000;
  assert.equal(await gate.query('bad', 1, 100, async () => ({ secret: 'hidden' }), validate), null);
  assert.equal(await gate.query('hung', 1, 100,
    async () => new Promise<unknown>(() => {}), validate), null);
});
