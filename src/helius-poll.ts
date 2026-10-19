import { fileURLToPath } from 'node:url';
import { runHeliusPollCycle } from './application/helius-poll-cycle.ts';
import {
  readDiscoveryCursorState, withDiscoveryCursorLock, writeDiscoveryCursorState
} from './discovery/cursor-store.ts';
import { safePollFailureDetail } from './discovery/poll-diagnostics.ts';
import { HeliusReadOnlyClient } from './providers/solana/helius-readonly.ts';

const statePath = fileURLToPath(new URL('../data/helius-discovery-cursors.json', import.meta.url));
const lockPath = `${statePath}.lock`;
let failureStage = 'starting';

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
  const detail = safePollFailureDetail(error, process.env.HELIUS_API_KEY);
  process.stderr.write(`HELIUS_POLL_FAILED at ${failureStage}: ${detail}; no transaction was submitted.\n`);
  process.exitCode = 1;
});
