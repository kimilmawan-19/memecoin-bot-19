import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseBaseUnits, parseBasisPoints, parseChangeBps, parseIsoTime,
  parseRatioBps, parseSignedBaseUnits } from '../src/core/invariants.ts';
import { parseScreenerProposal } from '../src/core/proposal.ts';
import { canTransition } from '../src/core/execution-state.ts';
import { FIXTURE_CAPABILITIES, selectMode } from '../src/application/mode.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const proposal = {
  candidateId: 'candidate-1', snapshotId: 'snapshot-1', action: 'BUY',
  rationale: 'Mock proposal for contract test', risks: ['unknown-market'],
  evidenceIds: ['fixture-1'], modelVersion: 'mock-1', promptVersion: 'test-1',
  createdAt: '2026-09-28T00:00:00.000Z', expiresAt: '2026-09-28T00:01:00.000Z'
};

test('units and UTC timestamps reject ambiguous values', () => {
  assert.equal(parseBaseUnits('9007199254740993'), '9007199254740993');
  assert.throws(() => parseBaseUnits(100));
  assert.throws(() => parseBaseUnits('1.5'));
  assert.equal(parseSignedBaseUnits('-9007199254740993'), '-9007199254740993');
  assert.throws(() => parseSignedBaseUnits('-0'));
  assert.equal(parseBasisPoints(10_000), 10_000);
  assert.throws(() => parseBasisPoints(10_001));
  assert.equal(parseChangeBps(-15_000), -15_000);
  assert.equal(parseRatioBps(25_000), 25_000);
  assert.throws(() => parseRatioBps(-1));
  assert.throws(() => parseIsoTime('2026-09-28T07:00:00+07:00'));
});

test('mock BUY is a bounded, immutable proposal, not execution authority', () => {
  const parsed = parseScreenerProposal(proposal);
  assert.equal(parsed.action, 'BUY');
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.evidenceIds), true);
  assert.equal('authorizationId' in parsed, false);
  assert.throws(() => parseScreenerProposal({ ...proposal, privateKey: 'secret' }));
  assert.throws(() => parseScreenerProposal({ ...proposal, evidenceIds: [] }));
  assert.throws(() => parseScreenerProposal({ ...proposal, action: 'SELL' }));
});

test('runtime mode has no signing or transaction submission capability', () => {
  assert.equal(selectMode(undefined), 'fixture');
  assert.equal(selectMode('fixture'), 'fixture');
  assert.throws(() => selectMode('live'));
  assert.throws(() => selectMode('paper'));
  assert.equal(FIXTURE_CAPABILITIES.sign, false);
  assert.equal(FIXTURE_CAPABILITIES.submitTransaction, false);
});

test('unknown submission cannot be retried without reconciliation', () => {
  assert.equal(canTransition('PROPOSED', 'AUTHORIZED', 'guard'), true);
  assert.equal(canTransition('PROPOSED', 'SUBMITTED', 'submit'), false);
  assert.equal(canTransition('SUBMITTED', 'UNKNOWN', 'reconciliation'), true);
  assert.equal(canTransition('UNKNOWN', 'SUBMITTED', 'submit'), false);
  assert.equal(canTransition('UNKNOWN', 'FAILED', 'submit'), false);
  assert.equal(canTransition('UNKNOWN', 'CONFIRMED', 'reconciliation'), true);
});

test('core, application, and screener imports remain read-only and provider-free', async () => {
  async function files(directory: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const nested = await Promise.all(entries.filter((entry) => entry.isDirectory())
      .map((entry) => files(`${directory}/${entry.name}`)));
    return [...entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => `${directory}/${entry.name}`), ...nested.flat()];
  }
  const paths = [...await files('src/core'), ...await files('src/application'),
    ...await files('src/agents'), ...await files('src/learning'), 'src/screener.ts'];
  for (const path of paths) {
    const content = await readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
    const imports = [...content.matchAll(/(?:from\s*|import\s*\(|import\s+|require\s*\()\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    assert.ok(imports.every((name) => name.startsWith('.') && !name.includes('execution')),
      `${path} imports an external or execution module`);
    assert.doesNotMatch(content, /\b(?:fetch|require|eval|Function)\s*\(|\bprocess\.env\b|\bimport\s*\(\s*[^'"\s]/,
      `${path} uses a forbidden capability`);
  }
  const manifest = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(manifest.dependencies, undefined);
});
