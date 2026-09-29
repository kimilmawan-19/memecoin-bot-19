import { parseBaseUnits, parseBasisPoints } from '../core/invariants.ts';
import { validSolanaAddress } from '../input.ts';

export type RiskPolicyConfig = Readonly<{
  version: string;
  quoteMint: string;
  minLiquidityQuoteRaw: string;
  maxPositionQuoteRaw: string;
  maxTotalExposureQuoteRaw: string;
  maxDailyLossQuoteRaw: string;
  maxConcurrentOrders: number;
  maxOpenPositions: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeRaw: string;
  allowedProgramIds: readonly string[];
}>;

const ID = /^[a-zA-Z0-9:._-]{1,128}$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

export function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid policy identifier');
  return value;
}

export function units(value: unknown): bigint {
  const amount = BigInt(parseBaseUnits(value));
  if (amount > MAX_U64) throw new Error('Amount exceeds u64');
  return amount;
}

// Configuration is local, versioned input. Unknown fields are rejected so an
// accidental or model-generated setting cannot silently change the policy.
export function parseRiskPolicy(value: unknown): RiskPolicyConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid risk policy');
  }
  const input = value as Record<string, unknown>;
  const keys = ['version', 'quoteMint', 'minLiquidityQuoteRaw', 'maxPositionQuoteRaw',
    'maxTotalExposureQuoteRaw', 'maxDailyLossQuoteRaw', 'maxConcurrentOrders',
    'maxOpenPositions', 'maxSlippageBps', 'maxPriceImpactBps', 'maxFeeRaw',
    'allowedProgramIds'];
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) {
    throw new Error('Invalid risk policy');
  }
  if (!Array.isArray(input.allowedProgramIds) || input.allowedProgramIds.length === 0 ||
      input.allowedProgramIds.length > 12) throw new Error('Invalid program allowlist');
  const allowedProgramIds = input.allowedProgramIds.map(id);
  if (new Set(allowedProgramIds).size !== allowedProgramIds.length) {
    throw new Error('Duplicate allowed program');
  }
  if (!validSolanaAddress(input.quoteMint) ||
      allowedProgramIds.some((item) => !validSolanaAddress(item))) {
    throw new Error('Invalid Solana address in policy');
  }
  if (typeof input.maxConcurrentOrders !== 'number' ||
      !Number.isSafeInteger(input.maxConcurrentOrders) ||
      input.maxConcurrentOrders < 1 || input.maxConcurrentOrders > 100 ||
      typeof input.maxOpenPositions !== 'number' ||
      !Number.isSafeInteger(input.maxOpenPositions) ||
      input.maxOpenPositions < 1 || input.maxOpenPositions > 100) {
    throw new Error('Invalid order limit');
  }
  const result = {
    version: id(input.version), quoteMint: id(input.quoteMint),
    minLiquidityQuoteRaw: units(input.minLiquidityQuoteRaw).toString(),
    maxPositionQuoteRaw: units(input.maxPositionQuoteRaw).toString(),
    maxTotalExposureQuoteRaw: units(input.maxTotalExposureQuoteRaw).toString(),
    maxDailyLossQuoteRaw: units(input.maxDailyLossQuoteRaw).toString(),
    maxConcurrentOrders: input.maxConcurrentOrders,
    maxOpenPositions: input.maxOpenPositions,
    maxSlippageBps: parseBasisPoints(input.maxSlippageBps),
    maxPriceImpactBps: parseBasisPoints(input.maxPriceImpactBps),
    maxFeeRaw: units(input.maxFeeRaw).toString(),
    allowedProgramIds: Object.freeze(allowedProgramIds)
  };
  if (units(result.minLiquidityQuoteRaw) === 0n ||
      units(result.maxPositionQuoteRaw) === 0n ||
      units(result.maxTotalExposureQuoteRaw) < units(result.maxPositionQuoteRaw) ||
      units(result.maxDailyLossQuoteRaw) === 0n ||
      result.maxSlippageBps === 10_000 || result.maxPriceImpactBps === 10_000) {
    throw new Error('Invalid risk limits');
  }
  return Object.freeze(result);
}

export function recent(value: unknown, now: Date, maxAgeMs: number): boolean {
  if (typeof value !== 'string' || !Number.isFinite(now.getTime())) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value &&
    now.getTime() - time >= 0 && now.getTime() - time <= maxAgeMs;
}
