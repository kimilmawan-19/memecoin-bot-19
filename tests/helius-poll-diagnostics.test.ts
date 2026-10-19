import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safePollFailureDetail } from '../src/discovery/poll-diagnostics.ts';

test('poll diagnostics identify known internal failures without exposing secret material', () => {
  assert.equal(safePollFailureDetail(new Error('Discovery cursor gap; backfill required')),
    'Discovery cursor gap; backfill required');
  assert.equal(safePollFailureDetail(new Error('Discovery backfill passed its anchor; review required')),
    'Discovery backfill passed its anchor; review required');
  const detail = safePollFailureDetail(new Error(
    'request failed for https://rpc.example/?api-key=secret-value at C:\\Users\\private\\repo token=hidden'),
  'secret-value');
  assert.match(detail, /^unexpected Error:/);
  assert.ok(!detail.includes('secret-value'));
  assert.ok(!detail.includes('hidden'));
  assert.ok(!detail.includes('C:\\Users'));
  assert.ok(!detail.includes('https://rpc.example'));
});

test('signature row diagnostics reveal only the rejected field', () => {
  for (const field of ['object', 'signature', 'slot', 'err missing', 'err type string',
    'err type number', 'err type boolean', 'err type array', 'err type undefined']) {
    assert.equal(safePollFailureDetail(new Error(`Invalid signature row: ${field}`)),
      `Invalid signature row: ${field}`);
  }
});
