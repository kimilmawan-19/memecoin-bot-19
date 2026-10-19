import { fileURLToPath } from 'node:url';
import { runHeliusPollCycle } from './application/helius-poll-cycle.ts';
import {
  readDiscoveryCursorState, withDiscoveryCursorLock, writeDiscoveryCursorState
} from './discovery/cursor-store.ts';
import { HeliusReadOnlyClient } from './providers/solana/helius-readonly.ts';

const statePath = fileURLToPath(new URL('../data/helius-discovery-cursors.json', import.meta.url));
const lockPath = `${statePath}.lock`;
let failureStage = 'starting';

const SAFE_FAILURES = new Set([
  'Invalid Helius API key configuration',
  'Helius RPC unavailable',
  'Invalid Helius cluster response',
  'Invalid Helius slot response',
  'Helius endpoint is not Solana mainnet',
  'Invalid discovery query',
  'Invalid signature page',
  'Invalid signature row',
  'Invalid discovery signature page',
  'Invalid discovery signature order',
  'Discovery cursor gap; backfill required',
  'Discovery backpressure limit reached',
  'Discovery transaction unavailable; retry later',
  'Discovery transaction mismatch',
  'Invalid local discovery checkpoint',
  'Unable to read local discovery checkpoint',
  'Unable to save local discovery checkpoint',
  'Invalid discovery cursor state',
  'Invalid discovery checkpoint time',
  'Unable to create local discovery lock',
  'Discovery poll is already running or a stale local lock needs review'
]);

async function writeOutput(value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(serialized, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  failureStage = 'validating command arguments';
  if (process.argv.length > 2) {
    process.stderr.write('Usage: node src/helius-poll.ts\n');
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    process.stderr.write('HELIUS_API_KEY is required for the local read-only check.\n');
    process.exitCode = 2;
    return;
  }
  failureStage = 'creating read-only Helius client';
  const client = new HeliusReadOnlyClient(apiKey);
  failureStage = 'acquiring local poll lock';
  await withDiscoveryCursorLock(lockPath, async () => {
    failureStage = 'reading local checkpoint';
    const previousCursors = await readDiscoveryCursorState(statePath);
    failureStage = 'reading finalized Helius data';
    const cycle = await runHeliusPollCycle(client, previousCursors);
    // Write the result before advancing the durable checkpoint. A failed save
    // may replay a batch, but cannot silently skip it.
    failureStage = 'writing cycle result';
    await writeOutput(cycle.result);
    failureStage = 'saving local checkpoint';
    await writeDiscoveryCursorState(statePath, cycle.cursors);
  });
}

main().catch((error: unknown) => {
  const detail = error instanceof Error && SAFE_FAILURES.has(error.message) ? error.message : 'unexpected error';
  process.stderr.write(`HELIUS_POLL_FAILED at ${failureStage}: ${detail}; no transaction was submitted.\n`);
  process.exitCode = 1;
});
