import type { ExecutionResult } from '../../core/models.ts';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const IDENTIFIER = /^[a-zA-Z0-9:._-]{1,128}$/;

function signature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 64 || value.length > 88) return false;
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
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 64;
}

// Pure shape mapping only; never means confirmed, filled, or safe to retry.
// Raw SDK errors and timing metadata are deliberately discarded.
export function normalizeFnzeroTradeResult(intentId: string, raw: unknown): ExecutionResult {
  if (!IDENTIFIER.test(intentId)) throw new Error('Invalid intent ID');
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ?
    raw as Record<string, unknown> : {};
  const candidate = input.signatures;
  const signatures = Array.isArray(candidate) && candidate.length <= 8 &&
    candidate.every(signature) && new Set(candidate).size === candidate.length ?
      Object.freeze([...candidate] as string[]) : Object.freeze([] as string[]);
  const submitted = input.success === true && signatures.length > 0 &&
    !Object.hasOwn(input, 'simulation');
  return Object.freeze({
    intentId,
    status: submitted ? 'SUBMITTED' : 'UNKNOWN',
    signatures,
    inputFilledRaw: null,
    outputFilledRaw: null,
    feePaidRaw: null,
    confirmedAt: null
  });
}
