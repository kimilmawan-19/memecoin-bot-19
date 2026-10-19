import { runHeliusReadOnlyCycle } from './application/helius-readonly-cycle.ts';
import { HeliusReadOnlyClient } from './providers/solana/helius-readonly.ts';

async function main(): Promise<void> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    process.stderr.write('HELIUS_API_KEY is required for the local read-only check.\n');
    process.exitCode = 2;
    return;
  }
  if (process.argv.length > 2) {
    process.stderr.write('Usage: pnpm helius:readonly\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runHeliusReadOnlyCycle(new HeliusReadOnlyClient(apiKey));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('HELIUS_READONLY_CYCLE_FAILED; no transaction was submitted.\n');
    process.exitCode = 1;
  }
}

void main();
