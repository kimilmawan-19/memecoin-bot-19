import type { ScreenerProposal } from './models.ts';
import { parseIsoTime } from './invariants.ts';

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[a-zA-Z0-9:._-]+$/.test(value)) {
    throw new Error('Invalid proposal');
  }
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
    throw new Error('Invalid proposal');
  }
  return value;
}

function identifiers(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid proposal');
  return Object.freeze(value.map(identifier));
}

// Treat every model response as unknown input. Never use this result as an
// authorization; it has no execution capability or signer reference.
export function parseScreenerProposal(value: unknown): ScreenerProposal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid proposal');
  }
  const input = value as Record<string, unknown>;
  const expected = ['candidateId', 'snapshotId', 'action', 'rationale', 'risks',
    'evidenceIds', 'modelVersion', 'promptVersion', 'createdAt', 'expiresAt'];
  if (Object.keys(input).length !== expected.length || expected.some((key) => !Object.hasOwn(input, key))) {
    throw new Error('Invalid proposal');
  }
  if (input.action !== 'BUY' && input.action !== 'SKIP') throw new Error('Invalid proposal');
  const createdAt = parseIsoTime(input.createdAt);
  const expiresAt = parseIsoTime(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt) ||
      Date.parse(expiresAt) - Date.parse(createdAt) > 5 * 60 * 1000) {
    throw new Error('Invalid proposal expiry');
  }
  const evidenceIds = identifiers(input.evidenceIds);
  if (input.action === 'BUY' && evidenceIds.length === 0) throw new Error('Invalid proposal evidence');
  return Object.freeze({
    candidateId: identifier(input.candidateId),
    snapshotId: identifier(input.snapshotId),
    action: input.action,
    rationale: boundedText(input.rationale),
    risks: identifiers(input.risks),
    evidenceIds,
    modelVersion: identifier(input.modelVersion),
    promptVersion: identifier(input.promptVersion),
    createdAt,
    expiresAt
  });
}
