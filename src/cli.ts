import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCycle } from './cycle.ts';
import { loadCandidates } from './input.ts';
import { selectMode } from './application/mode.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultInput = fileURLToPath(new URL('../fixtures/candidates.json', import.meta.url));
const logDirectory = resolve(projectRoot, 'data');
const logPath = resolve(logDirectory, 'decisions.jsonl');

async function main(): Promise<void> {
  selectMode(process.env.BOT_MODE);
  if (process.argv.length > 3) throw new Error('Usage: node src/cli.ts [candidate-file.json]');
  const candidates = await loadCandidates(process.argv[2] ?? defaultInput);
  const decisions = runCycle(candidates, new Date());
  await mkdir(logDirectory, { recursive: true });
  for (const decision of decisions) {
    await appendFile(logPath, `${JSON.stringify(decision)}\n`, { mode: 0o600 });
    process.stdout.write(`${decision.mint} ${decision.gate.status} ${decision.decision.action}\n`);
  }
}

main().catch(() => {
  process.stderr.write('Cycle failed: invalid input or local storage error. No action was taken.\n');
  process.exitCode = 1;
});
