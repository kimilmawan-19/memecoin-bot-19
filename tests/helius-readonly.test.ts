import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runHeliusReadOnlyCycle } from '../src/application/helius-readonly-cycle.ts';
import type { DiscoveryRpc } from '../src/discovery/poll.ts';
import { PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../src/discovery/parse-transaction.ts';
import {
  HeliusReadOnlyClient, HELIUS_MAINNET_ENDPOINT, SOLANA_MAINNET_GENESIS_HASH
} from '../src/providers/solana/helius-readonly.ts';

const API_KEY = 'local-test-key-never-real';
const OTHER = '11111111111111111111111111111111';

test('Helius client pins mainnet host, attaches key only to requests, and reads finalized status', async () => {
  const requests: Array<{ url: URL; body: Record<string, unknown> }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    const result = body.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS_HASH :
      body.method === 'getSlot' ? 456_000_123 : [];
    return Response.json({ jsonrpc: '2.0', id: 1, result }, {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const client = new HeliusReadOnlyClient(API_KEY, fetcher);
  assert.deepEqual(await client.status(), {
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    finalizedSlot: 456_000_123
  });
  assert.deepEqual(await client.discovery.signatures(PUMP_PROGRAM, 2), []);
  assert.deepEqual(requests.map((request) => request.body.method),
    ['getGenesisHash', 'getSlot', 'getSignaturesForAddress']);
  assert.ok(requests.every(({ url }) => url.origin + url.pathname === HELIUS_MAINNET_ENDPOINT));
  assert.ok(requests.every(({ url }) => url.searchParams.get('api-key') === API_KEY));
  assert.ok(requests.every(({ body }) => !JSON.stringify(body).includes(API_KEY)));
  assert.deepEqual(requests[2].body.params, [PUMP_PROGRAM, { commitment: 'finalized', limit: 2 }]);
});

test('Helius RPC failures are sanitized and invalid credentials are rejected before network access', async () => {
  let calls = 0;
  const badResponse = (async () => {
    calls++;
    return new Response(`secret ${API_KEY}`, { status: 403, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  await assert.rejects(new HeliusReadOnlyClient(API_KEY, badResponse).status(), (error: Error) =>
    error.message === 'Helius RPC unavailable' && !error.message.includes(API_KEY));
  assert.equal(calls, 1);
  assert.throws(() => new HeliusReadOnlyClient('bad\nkey', badResponse), /Invalid Helius API key configuration/);
  assert.equal(calls, 1);
});

test('recent Helius discovery reaches the risk gate and remains SKIP with no execution capability', async () => {
  const recorded = JSON.parse(await readFile(new URL('../fixtures/phase4-onchain.json', import.meta.url), 'utf8'));
  const item = recorded.cases[0];
  const instructions = Array.from({ length: item.outerIndex + 1 }, () => ({ programId: OTHER }));
  instructions[item.outerIndex] = item.instruction;
  let signaturesCalls = 0;
  let transactionCalls = 0;
  const discovery: DiscoveryRpc = {
    async signatures(program, limit) {
      signaturesCalls++;
      assert.ok(limit <= 5);
      return program === PUMP_PROGRAM ? [{ signature: item.signature, slot: item.slot, err: null }] : [];
    },
    async transaction(signature) {
      transactionCalls++;
      assert.equal(signature, item.signature);
      return {
        slot: item.slot,
        blockTime: item.blockTime,
        meta: { err: null },
        transaction: { signatures: [item.signature], message: { instructions } }
      };
    }
  };
  const client = {
    discovery,
    async status() {
      return { genesisHash: SOLANA_MAINNET_GENESIS_HASH, finalizedSlot: item.slot };
    }
  };
  const result = await runHeliusReadOnlyCycle(client, new Date('2026-10-19T00:00:00.000Z'));
  assert.equal(signaturesCalls, 2);
  assert.equal(transactionCalls, 1);
  assert.equal(result.network, 'solana-mainnet');
  assert.equal(result.eventsDiscovered, 1);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.decisions.map(({ gate, action }) => ({ gate, action })), [
    { gate: 'UNKNOWN', action: 'SKIP' }
  ]);
  assert.deepEqual(result.safety, { readOnly: true, signingEnabled: false, transactionsSubmitted: 0 });
});

test('recent scan stops before discovery calls if the Helius endpoint is not mainnet', async () => {
  let signaturesCalls = 0;
  const client = {
    discovery: {
      async signatures() { signaturesCalls++; return []; },
      async transaction() { return null; }
    },
    async status() { return { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', finalizedSlot: 1 }; }
  };
  await assert.rejects(runHeliusReadOnlyCycle(client), /not Solana mainnet/);
  assert.equal(signaturesCalls, 0);
});
