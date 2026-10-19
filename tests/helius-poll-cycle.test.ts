import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runHeliusPollCycle } from '../src/application/helius-poll-cycle.ts';
import type { DiscoveryRpc, SignatureInfo } from '../src/discovery/poll.ts';
import { PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../src/discovery/parse-transaction.ts';
import { SOLANA_MAINNET_GENESIS_HASH } from '../src/providers/solana/helius-readonly.ts';

test('Helius polling initializes, resumes after restart, and keeps new candidates at UNKNOWN/SKIP', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/phase4-onchain.json', import.meta.url), 'utf8'));
  const item = fixture.cases[0];
  const headSignature = item.signature as string;
  const newSignature = '1'.repeat(88);
  const instructions = Array.from({ length: item.outerIndex + 1 }, () => ({
    programId: '11111111111111111111111111111111'
  }));
  instructions[item.outerIndex] = item.instruction;
  const pages = new Map<string, readonly SignatureInfo[]>([
    [PUMP_PROGRAM, [{ signature: headSignature, slot: item.slot, err: null }]],
    [RAYDIUM_CPMM_PROGRAM, []]
  ]);
  const transactions = new Map<string, unknown>();
  const discovery: DiscoveryRpc = {
    async signatures(program) { return pages.get(program) ?? []; },
    async transaction(signature) { return transactions.get(signature) ?? null; }
  };
  const client = {
    discovery,
    async status() {
      return { genesisHash: SOLANA_MAINNET_GENESIS_HASH, finalizedSlot: item.slot + 1 };
    }
  };

  const first = await runHeliusPollCycle(client, null, new Date('2026-10-19T00:00:00.000Z'));
  assert.equal(first.result.checkpoint, 'initialized');
  assert.equal(first.result.signaturesRead, 1);
  assert.equal(first.result.transactionsRead, 0);
  assert.deepEqual(first.result.decisions, []);
  assert.deepEqual(first.cursors, {
    [PUMP_PROGRAM]: headSignature,
    [RAYDIUM_CPMM_PROGRAM]: null
  });

  pages.set(PUMP_PROGRAM, [
    { signature: newSignature, slot: item.slot + 1, err: null },
    { signature: headSignature, slot: item.slot, err: null }
  ]);
  transactions.set(newSignature, {
    slot: item.slot + 1,
    blockTime: item.blockTime,
    meta: { err: null, innerInstructions: [] },
    transaction: { signatures: [newSignature], message: { instructions } }
  });
  const resumed = await runHeliusPollCycle(client, first.cursors, new Date('2026-10-19T00:01:00.000Z'));
  assert.equal(resumed.result.checkpoint, 'advanced');
  assert.equal(resumed.result.signaturesRead, 2);
  assert.equal(resumed.result.transactionsRead, 1);
  assert.equal(resumed.result.eventsDiscovered, 1);
  assert.equal(resumed.result.candidates, 1);
  assert.deepEqual(resumed.result.decisions.map(({ gate, action }) => ({ gate, action })), [
    { gate: 'UNKNOWN', action: 'SKIP' }
  ]);
  assert.deepEqual(resumed.result.safety, {
    readOnly: true, signingEnabled: false, transactionsSubmitted: 0
  });
});

test('Helius polling rejects a non-mainnet endpoint before reading signatures', async () => {
  let calls = 0;
  const client = {
    discovery: {
      async signatures() { calls++; return []; },
      async transaction() { calls++; return null; }
    },
    async status() { return { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', finalizedSlot: 1 }; }
  };
  await assert.rejects(runHeliusPollCycle(client, null), /not Solana mainnet/);
  assert.equal(calls, 0);
});
