import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpDiscoveryRpc } from '../src/providers/solana/discovery-rpc.ts';
import { PUMP_PROGRAM } from '../src/discovery/parse-transaction.ts';

test('signature page validation identifies only the invalid row field', async () => {
  const signature = '2'.repeat(88);
  const cases: readonly [unknown, string][] = [
    [null, 'Invalid signature row: object'],
    [{ signature: 'not-a-signature', slot: 1, err: null }, 'Invalid signature row: signature'],
    [{ signature, slot: '1', err: null }, 'Invalid signature row: slot'],
    [{ signature, slot: 1 }, 'Invalid signature row: err missing'],
    [{ signature, slot: 1, err: 'unexpected' }, 'Invalid signature row: err type string'],
    [{ signature, slot: 1, err: [] }, 'Invalid signature row: err type array']
  ];

  for (const [row, expected] of cases) {
    const fetcher = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [row] }), {
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
    const rpc = new HttpDiscoveryRpc('https://rpc.example.test', fetcher);
    await assert.rejects(rpc.signatures(PUMP_PROGRAM, 1), (error: Error) => error.message === expected);
  }
});
