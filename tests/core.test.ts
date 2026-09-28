import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCandidates, validSolanaAddress } from '../src/input.ts';
import { assessRisk } from '../src/risk.ts';
import { runCycle } from '../src/cycle.ts';

const NOW = new Date('2026-09-28T00:00:00.000Z');
const MINT = 'So11111111111111111111111111111111111111112';
function document(risk: Record<string, unknown>, observedAt = NOW.toISOString()): unknown {
  return { version: 1, candidates: [{ mint: MINT, observedAt, source: 'fixture', risk }] };
}
const safeFacts = { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, liquidityUsd: 100000 };

test('validates 32-byte Solana addresses and rejects extra input fields', () => {
  assert.equal(validSolanaAddress(MINT), true);
  assert.equal(validSolanaAddress('not-a-mint'), false);
  assert.throws(() => parseCandidates({ ...document(safeFacts) as object, privateKey: 'secret' }));
  assert.throws(() => parseCandidates(document({ ...safeFacts, privateKey: 'secret' })));
});

test('unknown, stale, and active authorities fail closed', () => {
  const [unknown] = parseCandidates(document({ ...safeFacts, mintAuthorityRevoked: null }));
  assert.equal(assessRisk(unknown, NOW).status, 'UNKNOWN');
  const [stale] = parseCandidates(document(safeFacts, '2026-09-27T00:00:00.000Z'));
  assert.equal(assessRisk(stale, NOW).status, 'UNKNOWN');
  const [unsafe] = parseCandidates(document({ ...safeFacts, freezeAuthorityRevoked: false }));
  assert.equal(assessRisk(unsafe, NOW).status, 'REJECT');
});

test('even a passing fixture can only produce SKIP', () => {
  const candidates = parseCandidates(document(safeFacts));
  const [record] = runCycle(candidates, NOW);
  assert.equal(record.gate.status, 'PASS');
  assert.equal(record.decision.action, 'SKIP');
  assert.equal(record.decision.reason, 'STRATEGY_AND_EXECUTION_DISABLED');
  assert.equal(JSON.stringify(record).includes('privateKey'), false);
});

test('duplicate mints and invalid numeric values are rejected', () => {
  const raw = document(safeFacts) as { version: number; candidates: unknown[] };
  raw.candidates.push(raw.candidates[0]);
  assert.throws(() => parseCandidates(raw));
  assert.throws(() => parseCandidates(document({ ...safeFacts, liquidityUsd: -1 })));
});
