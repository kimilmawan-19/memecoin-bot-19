import type { PositionProposal } from './models.ts';
import { parseBasisPoints, parseIsoTime } from './invariants.ts';

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:._-]{1,128}$/.test(value)) {
    throw new Error('Invalid position proposal identifier');
  }
  return value;
}

export function parsePositionProposal(value: unknown): PositionProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid position proposal');
  const raw = value as Record<string, unknown>;
  const keys = ['positionId', 'positionVersion', 'snapshotId', 'action', 'reduceBps',
    'rationale', 'evidenceIds', 'modelVersion', 'promptVersion', 'createdAt', 'expiresAt'];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      !Number.isSafeInteger(raw.positionVersion) || (raw.positionVersion as number) < 0 ||
      !['HOLD', 'REDUCE', 'EXIT'].includes(raw.action as string) ||
      typeof raw.rationale !== 'string' || raw.rationale.length < 1 ||
      raw.rationale.length > 500 || /[\x00-\x1f\x7f]/.test(raw.rationale) ||
      !Array.isArray(raw.evidenceIds) || raw.evidenceIds.length > 20 ||
      raw.evidenceIds.some((item) => typeof item !== 'string') ||
      new Set(raw.evidenceIds).size !== raw.evidenceIds.length) {
    throw new Error('Invalid position proposal');
  }
  if (raw.action !== 'HOLD' && raw.evidenceIds.length === 0) {
    throw new Error('Missing position decision evidence');
  }
  if (raw.action === 'REDUCE') {
    const bps = parseBasisPoints(raw.reduceBps);
    if (bps === 0 || bps === 10_000) throw new Error('Invalid reduction');
  } else if (raw.reduceBps !== null) throw new Error('Unexpected reduction');
  const createdAt = parseIsoTime(raw.createdAt);
  const expiresAt = parseIsoTime(raw.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt) ||
      Date.parse(expiresAt) - Date.parse(createdAt) > 60_000) throw new Error('Invalid position proposal expiry');
  return Object.freeze({
    positionId: id(raw.positionId), positionVersion: raw.positionVersion as number,
    snapshotId: id(raw.snapshotId), action: raw.action as PositionProposal['action'],
    reduceBps: raw.reduceBps as number | null, rationale: raw.rationale,
    evidenceIds: Object.freeze(raw.evidenceIds.map(id)),
    modelVersion: id(raw.modelVersion), promptVersion: id(raw.promptVersion),
    createdAt, expiresAt
  });
}
