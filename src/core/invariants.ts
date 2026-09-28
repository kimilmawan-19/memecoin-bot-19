import type { BaseUnits, BasisPoints, ChangeBps, IsoTime, RatioBps, SignedBaseUnits } from './models.ts';

export function parseIsoTime(value: unknown): IsoTime {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Invalid UTC time');
  }
  return value;
}

export function parseBaseUnits(value: unknown): BaseUnits {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Invalid base-unit amount');
  }
  return value;
}

export function parseSignedBaseUnits(value: unknown): SignedBaseUnits {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value)) {
    throw new Error('Invalid signed base-unit amount');
  }
  return value;
}

export function parseBasisPoints(value: unknown): BasisPoints {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error('Invalid basis points');
  }
  return value;
}

export function parseChangeBps(value: unknown): ChangeBps {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Invalid change basis points');
  }
  return value;
}

export function parseRatioBps(value: unknown): RatioBps {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid ratio basis points');
  }
  return value;
}
