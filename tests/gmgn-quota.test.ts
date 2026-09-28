import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GmgnQueryGate, InMemoryWeightedQuota, RateLimited } from '../src/providers/gmgn/quota.ts';

const validate = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 20) throw new Error('Invalid schema');
  return value;
};
const identity = (route: string, schemaVersion = 'v1') => ({
  route, mint: 'So11111111111111111111111111111111111111112', schemaVersion
});

test('weighted quota is shared across gate instances and resets daily budget', async () => {
  let now = 0;
  const ledger = new InMemoryWeightedQuota(3, 3, 4);
  const first = new GmgnQueryGate(ledger, () => now);
  const second = new GmgnQueryGate(ledger, () => now);
  let calls = 0;
  const request = async () => { calls++; return 'ok'; };
  assert.equal(await first.query(identity('route-a'), 2, 100, request, validate), 'ok');
  assert.equal(await second.query(identity('route-b'), 2, 100, request, validate), null);
  now = 1000;
  assert.equal(await second.query(identity('route-b'), 2, 100, request, validate), 'ok');
  now = 2000;
  assert.equal(await first.query(identity('route-c'), 1, 100, request, validate), null);
  now = 86_400_000;
  assert.equal(await first.query(identity('route-c'), 1, 100, request, validate), 'ok');
  assert.equal(calls, 3);
});

test('cache and concurrent duplicate request spend quota once', async () => {
  let now = 0;
  const gate = new GmgnQueryGate(new InMemoryWeightedQuota(2, 1, 10), () => now);
  let calls = 0;
  const request = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return 'data'; };
  const [a, b] = await Promise.all([
    gate.query(identity('token'), 2, 100, request, validate),
    gate.query(identity('token'), 2, 100, request, validate)
  ]);
  assert.deepEqual([a, b], ['data', 'data']);
  assert.equal(calls, 1);
  assert.equal(await gate.query(identity('token'), 2, 100, request, validate), 'data');
  assert.equal(calls, 1);
  now = 101;
  assert.equal(await gate.query(identity('token'), 2, 100, request, validate), null);
});

test('429 cooldown, malformed data and timeout return no data or leaked error', async () => {
  let now = 0;
  const ledger = new InMemoryWeightedQuota(2, 2, 20);
  const gate = new GmgnQueryGate(ledger, () => now, 5);
  assert.equal(await gate.query(identity('one'), 1, 100, async () => {
    throw new RateLimited(3000);
  }, validate), null);
  now = 2000;
  assert.equal(await gate.query(identity('two'), 1, 100, async () => 'never', validate), null);
  now = 3000;
  assert.equal(await gate.query(identity('bad'), 1, 100, async () => ({ secret: 'hidden' }), validate), null);
  now = 3500;
  let aborted = false;
  assert.equal(await gate.query(identity('hung'), 1, 100,
    async (signal) => new Promise<unknown>(() => {
      signal.addEventListener('abort', () => { aborted = true; });
    }), validate), null);
  assert.equal(aborted, true);
});

test('quota spaces weighted requests instead of allowing a burst', async () => {
  const ledger = new InMemoryWeightedQuota(5, 5, 100);
  const atStart = await Promise.all(Array.from({ length: 5 }, () => ledger.reserve(1, 0)));
  assert.deepEqual(atStart, [true, false, false, false, false]);
  assert.equal(await ledger.reserve(1, 199), false);
  assert.equal(await ledger.reserve(1, 200), true);
  assert.equal(await ledger.reserve(2, 400), true);
  assert.equal(await ledger.reserve(1, 799), false);
  assert.equal(await ledger.reserve(1, 800), true);
});

test('route, mint, schema version, and validator isolate cached data', async () => {
  let now = 0;
  const gate = new GmgnQueryGate(new InMemoryWeightedQuota(5, 5, 100), () => now);
  let calls = 0;
  const request = async () => { calls++; return 'current'; };
  assert.equal(await gate.query(identity('token', 'v1'), 1, 1000, request, validate), 'current');
  now = 200;
  assert.equal(await gate.query(identity('token', 'v2'), 1, 1000, request, validate), 'current');
  now = 400;
  const rejectOld = (value: unknown): string => {
    if (value !== 'new') throw new Error('Schema changed');
    return value;
  };
  assert.equal(await gate.query(identity('token', 'v2'), 1, 1000,
    async () => { calls++; return 'new'; }, rejectOld), 'new');
  now = 600;
  assert.equal(await gate.query(identity('other', 'v2'), 1, 1000, request, validate), 'current');
  now = 800;
  assert.equal(await gate.query({ ...identity('token', 'v2'), mint: 'another-mint' },
    1, 1000, request, validate), 'current');
  assert.equal(calls, 5);
});
