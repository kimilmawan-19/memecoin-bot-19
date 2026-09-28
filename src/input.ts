import { readFile, stat } from 'node:fs/promises';
import type { CandidateSnapshot, RiskFacts } from './domain.ts';

const MAX_BYTES = 256 * 1024;
const MAX_CANDIDATES = 100;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid input schema');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== [...expected].sort()[i])) {
    throw new Error('Invalid input schema');
  }
}

export function validSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) {
    bytes++;
    number >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}

function parseRisk(value: unknown): RiskFacts {
  const risk = object(value);
  exactKeys(risk, ['mintAuthorityRevoked', 'freezeAuthorityRevoked', 'liquidityUsd']);
  for (const field of ['mintAuthorityRevoked', 'freezeAuthorityRevoked'] as const) {
    if (risk[field] !== null && typeof risk[field] !== 'boolean') throw new Error('Invalid risk fact');
  }
  if (risk.liquidityUsd !== null &&
      (typeof risk.liquidityUsd !== 'number' || !Number.isFinite(risk.liquidityUsd) || risk.liquidityUsd < 0)) {
    throw new Error('Invalid liquidity value');
  }
  return {
    mintAuthorityRevoked: risk.mintAuthorityRevoked as boolean | null,
    freezeAuthorityRevoked: risk.freezeAuthorityRevoked as boolean | null,
    liquidityUsd: risk.liquidityUsd as number | null
  };
}

export function parseCandidates(value: unknown): readonly CandidateSnapshot[] {
  const document = object(value);
  exactKeys(document, ['version', 'candidates']);
  if (document.version !== 1 || !Array.isArray(document.candidates) || document.candidates.length > MAX_CANDIDATES) {
    throw new Error('Invalid candidate document');
  }
  const seen = new Set<string>();
  return document.candidates.map((raw: unknown) => {
    const candidate = object(raw);
    exactKeys(candidate, ['mint', 'observedAt', 'source', 'risk']);
    if (!validSolanaAddress(candidate.mint) || candidate.source !== 'fixture' ||
        typeof candidate.observedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate.observedAt) ||
        !Number.isFinite(Date.parse(candidate.observedAt)) ||
        new Date(candidate.observedAt).toISOString() !== candidate.observedAt) {
      throw new Error('Invalid candidate identity or timestamp');
    }
    if (seen.has(candidate.mint)) throw new Error('Duplicate candidate');
    seen.add(candidate.mint);
    return {
      mint: candidate.mint,
      observedAt: candidate.observedAt,
      source: 'fixture',
      risk: parseRisk(candidate.risk)
    };
  });
}

export async function loadCandidates(path: string): Promise<readonly CandidateSnapshot[]> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid input file');
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('Invalid input file');
  try {
    return parseCandidates(JSON.parse(raw));
  } catch {
    throw new Error('Invalid candidate input');
  }
}
