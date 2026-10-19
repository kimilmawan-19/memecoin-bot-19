import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from './parse-transaction.ts';
import type { DiscoveryCursorState } from './poll.ts';
import { SOLANA_MAINNET_GENESIS_HASH } from '../providers/solana/helius-readonly.ts';

type StoredCursorDocument = Readonly<{
  schemaVersion: 2;
  network: 'solana-mainnet';
  genesisHash: string;
  updatedAt: string;
  cursors: DiscoveryCursorState;
}>;

const PROGRAMS = new Set([PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM]);
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const DOCUMENT_KEYS = ['cursors', 'genesisHash', 'network', 'schemaVersion', 'updatedAt'];

export async function readDiscoveryCursorState(path: string): Promise<DiscoveryCursorState | null> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error('Unable to read local discovery checkpoint');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Invalid local discovery checkpoint');
  }
  if (!isRecord(value) || !sameKeys(value, DOCUMENT_KEYS) ||
      value.network !== 'solana-mainnet' || value.genesisHash !== SOLANA_MAINNET_GENESIS_HASH ||
      typeof value.updatedAt !== 'string' || !isExactIsoTime(value.updatedAt) || !isRecord(value.cursors)) {
    throw new Error('Invalid local discovery checkpoint');
  }
  const cursors: Record<string, DiscoveryCursorState[string]> = {};
  if (value.schemaVersion === 1) {
    for (const [program, cursor] of Object.entries(value.cursors)) {
      if (!PROGRAMS.has(program) ||
          (cursor !== null && (typeof cursor !== 'string' || !SIGNATURE.test(cursor)))) {
        throw new Error('Invalid local discovery checkpoint');
      }
      cursors[program] = { cursor, backfill: null };
    }
    return cursors;
  }
  if (value.schemaVersion !== 2) throw new Error('Invalid local discovery checkpoint');
  for (const [program, state] of Object.entries(value.cursors)) {
    if (!PROGRAMS.has(program) || !validStoredProgramCursor(state)) {
      throw new Error('Invalid local discovery checkpoint');
    }
    cursors[program] = state;
  }
  return cursors;
}

export async function writeDiscoveryCursorState(
  path: string,
  cursors: DiscoveryCursorState,
  updatedAt = new Date()
): Promise<void> {
  if (!Number.isFinite(updatedAt.getTime())) throw new Error('Invalid discovery checkpoint time');
  for (const [program, state] of Object.entries(cursors)) {
    if (!PROGRAMS.has(program) || !validStoredProgramCursor(state)) {
      throw new Error('Invalid discovery cursor state');
    }
  }
  const document: StoredCursorDocument = {
    schemaVersion: 2,
    network: 'solana-mainnet',
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    updatedAt: updatedAt.toISOString(),
    cursors
  };
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch {
    throw new Error('Unable to save local discovery checkpoint');
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function withDiscoveryCursorLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    throw new Error('Unable to create local discovery lock');
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error('Discovery poll is already running or a stale local lock needs review');
    }
    throw new Error('Unable to create local discovery lock');
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function validStoredProgramCursor(value: unknown): value is DiscoveryCursorState[string] {
  if (!isRecord(value) || !sameKeys(value, ['cursor', 'backfill']) ||
      (value.cursor !== null && (typeof value.cursor !== 'string' || !SIGNATURE.test(value.cursor)))) return false;
  if (value.backfill === null) return true;
  if (!isRecord(value.backfill) || !sameKeys(value.backfill, ['anchor', 'before', 'targetHead'])) return false;
  return (value.backfill.anchor === null ||
      (typeof value.backfill.anchor === 'string' && SIGNATURE.test(value.backfill.anchor))) &&
    typeof value.backfill.before === 'string' && SIGNATURE.test(value.backfill.before) &&
    typeof value.backfill.targetHead === 'string' && SIGNATURE.test(value.backfill.targetHead);
}

function isExactIsoTime(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
