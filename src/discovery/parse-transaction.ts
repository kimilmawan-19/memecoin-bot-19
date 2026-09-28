import { validSolanaAddress } from '../input.ts';
import type { DiscoveryEvent } from './events.ts';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2q1NzybapC8G4wEGGkZwyTDt1v';
const QUOTES = new Set([WSOL, USDC]);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

type Rule = Readonly<{ kind: DiscoveryEvent['kind']; mint: number; pool: number | null; quote?: number }>;
// Discriminators and account order from the official Pump and Raydium CPMM IDLs.
const PUMP_RULES: Readonly<Record<string, Rule>> = {
  '181ec828051c0777': { kind: 'TOKEN_CREATED', mint: 0, pool: null },
  'd6904cec5f8b31b4': { kind: 'TOKEN_CREATED', mint: 0, pool: null },
  '9beae792ec9ea21e': { kind: 'PUMPSWAP_MIGRATED', mint: 2, pool: 9 },
  'bbcb121fceedfe29': { kind: 'PUMPSWAP_MIGRATED', mint: 2, pool: 10, quote: 3 }
};
const RAYDIUM_RULES: Readonly<Record<string, {pool: number; token0: number; token1: number}>> = {
  'afaf6d1f0d989bed': { pool: 3, token0: 4, token1: 5 },
  '3f37fe4131b25979': { pool: 4, token0: 5, token1: 6 }
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function discriminator(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) return null;
  let number = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  bytes.unshift(...Array(value.match(/^1*/)?.[0].length ?? 0).fill(0));
  return bytes.length >= 8 ? Buffer.from(bytes.slice(0, 8)).toString('hex') : null;
}

function account(accounts: unknown, index: number): string | null {
  if (!Array.isArray(accounts)) return null;
  const value = accounts[index];
  const key = typeof value === 'string' ? value : record(value)?.pubkey;
  return validSolanaAddress(key) ? key : null;
}

function instructionEvent(raw: unknown, slot: number, occurredAt: string,
  signature: string, location: string): DiscoveryEvent | null {
  const ix = record(raw);
  if (!ix) return null;
  const program = ix.programId;
  const id = discriminator(ix.data);
  if (!id) {
    if (program === PUMP_PROGRAM || program === RAYDIUM_CPMM_PROGRAM) {
      throw new Error('Invalid discovery instruction data');
    }
    return null;
  }
  let kind: DiscoveryEvent['kind'];
  let sourceId: DiscoveryEvent['sourceId'];
  let mint: string | null;
  let pool: string | null;
  if (program === PUMP_PROGRAM && PUMP_RULES[id]) {
    const rule = PUMP_RULES[id];
    if (rule.quote !== undefined && !QUOTES.has(account(ix.accounts, rule.quote) ?? '')) return null;
    mint = account(ix.accounts, rule.mint);
    pool = rule.pool === null ? null : account(ix.accounts, rule.pool);
    if (rule.pool !== null && !pool) throw new Error('Invalid discovery pool account');
    kind = rule.kind;
    sourceId = 'pumpfun';
  } else if (program === RAYDIUM_CPMM_PROGRAM && RAYDIUM_RULES[id]) {
    const rule = RAYDIUM_RULES[id];
    const token0 = account(ix.accounts, rule.token0);
    const token1 = account(ix.accounts, rule.token1);
    pool = account(ix.accounts, rule.pool);
    if (!pool || !token0 || !token1) throw new Error('Invalid discovery pool accounts');
    if (QUOTES.has(token0) === QUOTES.has(token1)) return null;
    mint = QUOTES.has(token0) ? token1 : token0;
    kind = 'RAYDIUM_POOL_CREATED';
    sourceId = 'raydium-cpmm';
  } else return null;
  if (!mint || mint === pool) throw new Error('Invalid discovery mint account');
  return { kind, sourceId, mint, pool, slot, occurredAt,
    evidenceId: `solana:${signature}:${location}` };
}

// Only successful, timestamped, parsed transactions yield evidence. Logs and
// token metadata are never treated as authoritative instructions.
export function parseDiscoveryTransaction(raw: unknown, signature: string): readonly DiscoveryEvent[] {
  if (!/^[A-Za-z0-9]{1,128}$/.test(signature)) throw new Error('Invalid discovery signature');
  const tx = record(raw);
  const meta = record(tx?.meta);
  const transaction = record(tx?.transaction);
  const message = record(transaction?.message);
  if (!tx || !meta || meta.err !== null || !transaction || !message ||
      !Number.isSafeInteger(tx.slot) || (tx.slot as number) < 0 ||
      !Number.isSafeInteger(tx.blockTime) || (tx.blockTime as number) < 0 ||
      (tx.blockTime as number) > 8_640_000_000 ||
      !Array.isArray(transaction.signatures) || transaction.signatures[0] !== signature ||
      !Array.isArray(message.instructions) || message.instructions.length > 128) {
    throw new Error('Invalid discovery transaction');
  }
  const occurredAt = new Date((tx.blockTime as number) * 1000).toISOString();
  const events: DiscoveryEvent[] = [];
  for (let i = 0; i < message.instructions.length; i++) {
    const event = instructionEvent(message.instructions[i], tx.slot as number, occurredAt, signature, `outer-${i}`);
    if (event) events.push(event);
  }
  if (meta.innerInstructions === null || meta.innerInstructions === undefined) return events;
  if (!Array.isArray(meta.innerInstructions) || meta.innerInstructions.length > 128) {
    throw new Error('Invalid discovery inner instructions');
  }
  for (const groupRaw of meta.innerInstructions) {
    const group = record(groupRaw);
    if (!group || !Number.isSafeInteger(group.index) || !Array.isArray(group.instructions) ||
        group.instructions.length > 128) throw new Error('Invalid discovery inner instructions');
    for (let i = 0; i < group.instructions.length; i++) {
      const event = instructionEvent(group.instructions[i], tx.slot as number, occurredAt,
        signature, `inner-${group.index}-${i}`);
      if (event) events.push(event);
    }
  }
  return events;
}
