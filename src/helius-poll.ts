import { fileURLToPath } from 'node:url';
import { runHeliusPollCycle } from './application/helius-poll-cycle.ts';
import {
  readDiscoveryCursorState, withDiscoveryCursorLock, writeDiscoveryCursorState
} from './discovery/cursor-store.ts';
import { HeliusReadOnlyClient } from './providers/solana/helius-readonly.ts';

const statePath = fileURLToPath(new URL('../data/helius-discovery-cursors.json', import.meta.url));
const lockPath = `${statePath}.lock`;

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
  const client = new HeliusReadOnlyClient(apiKey);
  await withDiscoveryCursorLock(lockPath, async () => {
    const previousCursors = await readDiscoveryCursorState(statePath);
    const cycle = await runHeliusPollCycle(client, previousCursors);
    // Write the result before advancing the durable checkpoint. A failed save
    // may replay a batch, but cannot silently skip it.
    await writeOutput(cycle.result);
    await writeDiscoveryCursorState(statePath, cycle.cursors);
  });
}

main().catch(() => {
  process.stderr.write('HELIUS_POLL_FAILED; no transaction was submitted.\n');
  process.exitCode = 1;
});
