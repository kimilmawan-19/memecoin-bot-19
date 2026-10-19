import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readDiscoveryCursorState, withDiscoveryCursorLock, writeDiscoveryCursorState
} from '../src/discovery/cursor-store.ts';
import { PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../src/discovery/parse-transaction.ts';
import { SOLANA_MAINNET_GENESIS_HASH } from '../src/providers/solana/helius-readonly.ts';

test('discovery checkpoint round-trips only mainnet cursor metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helius-cursor-'));
  const path = join(directory, 'data', 'cursors.json');
  const cursors = { [PUMP_PROGRAM]: '1'.repeat(88), [RAYDIUM_CPMM_PROGRAM]: null } as const;
  try {
    assert.equal(await readDiscoveryCursorState(path), null);
    await writeDiscoveryCursorState(path, cursors, new Date('2026-10-19T00:00:00.000Z'));
    assert.deepEqual(await readDiscoveryCursorState(path), cursors);
    const document = await readFile(path, 'utf8');
    assert.ok(document.includes(SOLANA_MAINNET_GENESIS_HASH));
    assert.ok(!document.toLowerCase().includes('api-key'));
    assert.ok(!document.includes('local-test-key'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid or foreign discovery checkpoint fails closed without being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helius-cursor-'));
  const path = join(directory, 'cursors.json');
  const invalid = {
    schemaVersion: 1,
    network: 'solana-devnet',
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    updatedAt: '2026-10-19T00:00:00.000Z',
    cursors: { [PUMP_PROGRAM]: '1'.repeat(88) }
  };
  try {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(readDiscoveryCursorState(path), /Invalid local discovery checkpoint/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), invalid);
    await writeFile(path, '{');
    await assert.rejects(readDiscoveryCursorState(path), /Invalid local discovery checkpoint/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery checkpoint lock blocks concurrent runs and releases after completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helius-cursor-'));
  const path = join(directory, 'poll.lock');
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const first = withDiscoveryCursorLock(path, async () => {
    start();
    await hold;
    return 'finished';
  });
  try {
    await started;
    await assert.rejects(withDiscoveryCursorLock(path, async () => 'overlap'), /already running/);
    release();
    assert.equal(await first, 'finished');
    assert.equal(await withDiscoveryCursorLock(path, async () => 'released'), 'released');
  } finally {
    release();
    await first.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
