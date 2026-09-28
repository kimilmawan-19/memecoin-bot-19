import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DiscoveryIndex } from '../src/discovery/events.ts';
import { DiscoveryPoller, type DiscoveryRpc, type SignatureInfo } from '../src/discovery/poll.ts';
import { parseDiscoveryTransaction, PUMP_PROGRAM, PUMPSWAP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM } from '../src/discovery/parse-transaction.ts';
import { HttpDiscoveryRpc } from '../src/providers/solana/discovery-rpc.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2q1NzybapC8G4wEGGkZwyTDt1v';
const OTHER = '11111111111111111111111111111111';
const MINT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const POOL = 'SysvarRent111111111111111111111111111111111';

function base58(bytes: number[]): string {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(bytes.findIndex((x) => x !== 0) < 0 ? bytes.length : bytes.findIndex((x) => x !== 0)) + out;
}

function ix(programId: string, discriminator: number[], accounts: string[]) {
  return { programId, data: base58([...discriminator, 1]), accounts };
}
function accounts(length: number, values: Record<number, string>): string[] {
  const result = Array<string>(length).fill(OTHER);
  for (const [index, value] of Object.entries(values)) result[Number(index)] = value;
  return result;
}
function tx(signature: string, slot: number, instructions: unknown[], innerInstructions: unknown[] = []) {
  return { slot, blockTime: 1_700_000_000 + slot, meta: { err: null, innerInstructions },
    transaction: { signatures: [signature], message: { instructions } } };
}

const create = ix(PUMP_PROGRAM, [24, 30, 200, 40, 5, 28, 7, 119], accounts(1, { 0: MINT }));
const createV2 = ix(PUMP_PROGRAM, [214, 144, 76, 236, 95, 139, 49, 180], accounts(1, { 0: MINT }));
const migrate = ix(PUMP_PROGRAM, [155, 234, 231, 146, 236, 158, 162, 30],
  accounts(10, { 2: MINT, 8: PUMPSWAP_PROGRAM, 9: POOL }));
const migrateV2 = ix(PUMP_PROGRAM, [187, 203, 18, 31, 206, 237, 254, 41],
  accounts(11, { 2: MINT, 3: WSOL, 9: PUMPSWAP_PROGRAM, 10: POOL }));
const raydium = ix(RAYDIUM_CPMM_PROGRAM, [175, 175, 109, 31, 13, 152, 155, 237],
  accounts(6, { 3: POOL, 4: WSOL, 5: MINT }));
const raydiumPermission = ix(RAYDIUM_CPMM_PROGRAM, [63, 55, 254, 65, 49, 178, 89, 121],
  accounts(7, { 4: POOL, 5: MINT, 6: USDC }));

test('official discriminators replay Pump create/migration and Raydium CPMM pool events', () => {
  const raw = tx('sig', 42, [create, createV2, migrate, migrateV2, raydium, raydiumPermission]);
  const events = parseDiscoveryTransaction(raw, 'sig');
  assert.deepEqual(events.map((x) => x.kind), [
    'TOKEN_CREATED', 'TOKEN_CREATED', 'PUMPSWAP_MIGRATED',
    'PUMPSWAP_MIGRATED', 'RAYDIUM_POOL_CREATED', 'RAYDIUM_POOL_CREATED'
  ]);
  assert.deepEqual(events.map((x) => x.mint), Array(6).fill(MINT));
  assert.equal(events[2].pool, POOL);
  assert.equal(events[4].sourceId, 'raydium-cpmm');
  assert.equal(new Set(events.map((x) => x.evidenceId)).size, 6);
});

test('recorded on-chain instruction slices replay three verified discovery events offline', async () => {
  const path = fileURLToPath(new URL('../fixtures/phase4-onchain.json', import.meta.url));
  const fixture = JSON.parse(await readFile(path, 'utf8')) as {
    version: number;
    cases: Array<{ signature: string; slot: number; blockTime: number; outerIndex: number;
      instruction: unknown; expected: { kind: string; mint: string; pool: string | null } }>;
  };
  assert.equal(fixture.version, 1);
  assert.equal(fixture.cases.length, 3);
  for (const item of fixture.cases) {
    const instructions = Array.from({ length: item.outerIndex + 1 }, () => ({ programId: OTHER }));
    instructions[item.outerIndex] = item.instruction as { programId: string };
    const raw = tx(item.signature, item.slot, instructions);
    const events = parseDiscoveryTransaction({ ...raw, blockTime: item.blockTime }, item.signature);
    assert.equal(events.length, 1, item.signature);
    assert.deepEqual({ kind: events[0].kind, mint: events[0].mint, pool: events[0].pool },
      item.expected, item.signature);
    assert.equal(events[0].evidenceId, `solana:${item.signature}:outer-${item.outerIndex}`);
  }
});

test('inner instructions are observed; forged logs, failed transactions and invalid payloads fail closed', () => {
  const raw = tx('sig', 42, [{ programId: OTHER, data: create.data, accounts: create.accounts }],
    [{ index: 0, instructions: [create] }]);
  assert.equal(parseDiscoveryTransaction(raw, 'sig').length, 1);
  assert.deepEqual(parseDiscoveryTransaction(tx('sig', 42, [], []), 'sig'), []);
  assert.throws(() => parseDiscoveryTransaction({ ...raw, meta: { err: { InstructionError: [0, 'Bad'] } } }, 'sig'));
  assert.throws(() => parseDiscoveryTransaction(raw, 'different'));
  assert.deepEqual(parseDiscoveryTransaction(tx('sig', 42, [
    { ...raydium, accounts: accounts(6, { 3: POOL, 4: MINT, 5: OTHER }) },
    { ...migrateV2, accounts: accounts(11, { 2: MINT, 3: OTHER, 9: PUMPSWAP_PROGRAM, 10: POOL }) }
  ]), 'sig'), []);
  assert.throws(() => parseDiscoveryTransaction(tx('sig', 42, [
    { ...create, data: 'not-base58' }
  ]), 'sig'));
  assert.throws(() => parseDiscoveryTransaction(tx('sig', 42, [
    { ...migrate, accounts: accounts(10, { 2: MINT, 9: POOL }) }
  ]), 'sig'), /PumpSwap/);
});

test('candidate index deduplicates, preserves provenance and accepts migration before creation', () => {
  const index = new DiscoveryIndex();
  const migration = parseDiscoveryTransaction(tx('migration', 12, [migrate]), 'migration')[0];
  const creation = parseDiscoveryTransaction(tx('creation', 10, [create]), 'creation')[0];
  assert.equal(index.ingest([migration]).candidates.length, 1);
  const second = index.ingest([creation, migration]);
  assert.equal(second.events.length, 1);
  assert.equal(second.candidates.length, 1);
  assert.equal(second.candidates[0].id, `solana:${MINT}`);
  assert.equal(second.candidates[0].discoveredAt, creation.occurredAt);
  assert.deepEqual(second.candidates[0].evidenceIds, [migration.evidenceId, creation.evidenceId]);
});

class FakeRpc implements DiscoveryRpc {
  readonly pages = new Map<string, SignatureInfo[]>();
  readonly transactions = new Map<string, unknown>();
  fail = false;
  async signatures(program: string): Promise<readonly SignatureInfo[]> {
    if (this.fail) throw new Error('secret remote failure body');
    return this.pages.get(program) ?? [];
  }
  async transaction(signature: string): Promise<unknown | null> {
    return this.transactions.get(signature) ?? null;
  }
}
const row = (signature: string, slot: number, err: unknown = null): SignatureInfo => ({ signature, slot, err });

test('poller bootstraps, replays oldest first, and resumes after RPC outage without cursor loss', async () => {
  const rpc = new FakeRpc();
  rpc.pages.set(PUMP_PROGRAM, [row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('r0', 1)]);
  const poller = new DiscoveryPoller(rpc, 3);
  assert.deepEqual(await poller.poll(), { candidates: [], events: [] });
  rpc.pages.set(PUMP_PROGRAM, [row('p2', 12), row('p1', 10), row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('r1', 11), row('r0', 1)]);
  rpc.transactions.set('p1', tx('p1', 10, [create]));
  rpc.transactions.set('p2', tx('p2', 12, [migrate]));
  rpc.transactions.set('r1', tx('r1', 11, [raydium]));
  rpc.fail = true;
  await assert.rejects(poller.poll(), /secret remote failure body/);
  rpc.fail = false;
  const batch = await poller.poll();
  assert.deepEqual(batch.events.map((x) => x.kind),
    ['TOKEN_CREATED', 'RAYDIUM_POOL_CREATED', 'PUMPSWAP_MIGRATED']);
  assert.equal(batch.candidates.length, 1);
  assert.equal(batch.candidates[0].evidenceIds.length, 3);
  assert.deepEqual(await poller.poll(), { candidates: [], events: [] });
});

test('gap, backpressure, missing transaction and mismatched slot do not advance cursor', async () => {
  const rpc = new FakeRpc();
  rpc.pages.set(PUMP_PROGRAM, [row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('r0', 1)]);
  const poller = new DiscoveryPoller(rpc, 2);
  await poller.poll();
  rpc.pages.set(PUMP_PROGRAM, [row('p4', 5), row('p3', 4), row('p2', 3)]);
  await assert.rejects(poller.poll(), /cursor gap/);
  rpc.pages.set(PUMP_PROGRAM, [row('p2', 3), row('p1', 2), row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('r1', 3), row('r0', 1)]);
  await assert.rejects(poller.poll(), /backpressure/);
  rpc.pages.set(PUMP_PROGRAM, [row('p1', 2), row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('r0', 1)]);
  await assert.rejects(poller.poll(), /unavailable/);
  rpc.transactions.set('p1', tx('p1', 3, [create]));
  await assert.rejects(poller.poll(), /mismatch/);
  rpc.transactions.set('p1', tx('p1', 2, [create]));
  assert.equal((await poller.poll()).events.length, 1);
});

test('one transaction seen by both program scans is fetched and indexed once', async () => {
  const rpc = new FakeRpc();
  rpc.pages.set(PUMP_PROGRAM, [row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('r0', 1)]);
  const poller = new DiscoveryPoller(rpc, 1);
  await poller.poll();
  rpc.pages.set(PUMP_PROGRAM, [row('shared', 2), row('p0', 1)]);
  rpc.pages.set(RAYDIUM_CPMM_PROGRAM, [row('shared', 2), row('r0', 1)]);
  rpc.transactions.set('shared', tx('shared', 2, [create, raydium]));
  const batch = await poller.poll();
  assert.equal(batch.events.length, 2);
  assert.equal(batch.candidates.length, 1);
});

test('HTTP RPC boundary rejects credential URLs and makes only finalized read calls', async () => {
  assert.throws(() => new HttpDiscoveryRpc('http://example.com'));
  assert.throws(() => new HttpDiscoveryRpc('https://user:pass@example.com'));
  const seen: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }),
      { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const rpc = new HttpDiscoveryRpc('https://rpc.example.com', fetcher);
  assert.deepEqual(await rpc.signatures(PUMP_PROGRAM, 2), []);
  assert.deepEqual(await rpc.transaction('2'.repeat(88)), []);
  assert.deepEqual(seen, [{ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
    params: [PUMP_PROGRAM, { commitment: 'finalized', limit: 2 }] },
  { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: ['2'.repeat(88),
    { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] }]);
  const leaking = new HttpDiscoveryRpc('https://rpc.example.com/private-path',
    (async () => { throw new Error('private-path: key material'); }) as typeof fetch);
  await assert.rejects(leaking.signatures(PUMP_PROGRAM, 1), (error: Error) =>
    error.message === 'Discovery RPC unavailable');
});
