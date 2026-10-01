import { parseBaseUnits, parseBasisPoints, parseIsoTime } from '../core/invariants.ts';
import { validSolanaAddress } from '../core/address.ts';
import { parseMarketContext } from '../core/market.ts';

export type FeatureTrade = Readonly<{
  id: string;
  at: string;
  wallet: string;
  side: 'BUY' | 'SELL';
  quoteRaw: string;
  // Absent means bundle attribution unavailable; null means observed unbundled.
  bundleId?: string | null;
}>;
export type FeatureWindow = Readonly<{ from: string; to: string; trades: readonly FeatureTrade[] }>;
export type WalletFact = Readonly<{
  wallet: string; ageDays: number | null; funder: string | null;
  bot: boolean | null; smartMoney: boolean | null;
}>;
export type VaultEvidence = Readonly<{
  poolId: string; poolProgram: string; poolAccountProgramOwner: string;
  poolStateVault: string; poolAuthority: string;
  tokenAccountOwner: string; tokenAccountMint: string; tokenAccountProgramOwner: string;
}>;
export type HolderAccount = Readonly<{
  tokenAccount: string; ownerWallet: string; balanceRaw: string;
  dev: boolean | null; bot: boolean | null; claimedVault: boolean;
  vaultEvidence?: VaultEvidence;
}>;
export type HolderFrame = Readonly<{
  observedAt: string; supplyRaw: string;
  previousObservedAt: string | null; previousHolderCount: number | null;
  accounts: readonly HolderAccount[];
}>;
export type LiquidityPoint = Readonly<{
  poolId: string; quoteMint: string; observedAt: string; quoteReserveRaw: string;
}>;
export type LiquidityFrame = LiquidityPoint & Readonly<{ previous: LiquidityPoint | null }>;
export type FeatureFrame = Readonly<{
  version: 1;
  candidateId: string; mint: string; sourceId: string; evidenceId: string;
  observedAt: string; coverageBps: number; confidenceBps: number;
  poolId: string; quoteMint: string; quoteDecimals: number;
  current: FeatureWindow; previous: FeatureWindow | null;
  wallets: readonly WalletFact[] | null;
  holders: HolderFrame | null;
  liquidity: LiquidityFrame | null;
}>;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid feature frame');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('Invalid feature frame');
  }
}

function id(value: unknown, maxLength = 96): string {
  if (typeof value !== 'string' || value.length > maxLength ||
      !/^[A-Za-z0-9:._-]{1,96}$/.test(value)) {
    throw new Error('Invalid feature identity');
  }
  return value;
}

function address(value: unknown): string {
  if (!validSolanaAddress(value)) throw new Error('Invalid feature address');
  return value;
}

function amount(value: unknown): string {
  const parsed = parseBaseUnits(value);
  if (parsed.length > 40) throw new Error('Invalid feature amount');
  return parsed;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid feature count');
  }
  return value as number;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value !== null && typeof value !== 'boolean') throw new Error('Invalid feature flag');
  return value;
}

function trade(value: unknown): FeatureTrade {
  const raw = object(value);
  keys(raw, ['id', 'at', 'wallet', 'side', 'quoteRaw'], ['bundleId']);
  if (raw.side !== 'BUY' && raw.side !== 'SELL') throw new Error('Invalid trade side');
  const quoteRaw = amount(raw.quoteRaw);
  if (quoteRaw === '0') throw new Error('Invalid trade amount');
  const result: FeatureTrade = {
    id: id(raw.id), at: parseIsoTime(raw.at), wallet: address(raw.wallet),
    side: raw.side, quoteRaw
  };
  if (Object.hasOwn(raw, 'bundleId')) {
    return Object.freeze({ ...result, bundleId: raw.bundleId === null ? null : id(raw.bundleId) });
  }
  return Object.freeze(result);
}

function window(value: unknown): FeatureWindow {
  const raw = object(value);
  keys(raw, ['from', 'to', 'trades']);
  if (!Array.isArray(raw.trades) || raw.trades.length > 100) throw new Error('Invalid trade window');
  const from = parseIsoTime(raw.from);
  const to = parseIsoTime(raw.to);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration < 60_000 || duration > 900_000) throw new Error('Invalid trade window');
  const trades = raw.trades.map(trade);
  if (trades.some((item) => item.at < from || item.at >= to)) throw new Error('Trade outside window');
  return Object.freeze({ from, to, trades: Object.freeze(trades) });
}

function wallet(value: unknown): WalletFact {
  const raw = object(value);
  keys(raw, ['wallet', 'ageDays', 'funder', 'bot', 'smartMoney']);
  const ageDays = raw.ageDays === null ? null : count(raw.ageDays);
  if (ageDays !== null && ageDays > 100_000) throw new Error('Invalid wallet age');
  return Object.freeze({ wallet: address(raw.wallet), ageDays,
    funder: raw.funder === null ? null : address(raw.funder),
    bot: nullableBoolean(raw.bot), smartMoney: nullableBoolean(raw.smartMoney) });
}

function vaultEvidence(value: unknown): VaultEvidence {
  const raw = object(value);
  const names = ['poolId', 'poolProgram', 'poolAccountProgramOwner', 'poolStateVault',
    'poolAuthority', 'tokenAccountOwner', 'tokenAccountMint', 'tokenAccountProgramOwner'];
  keys(raw, names);
  return Object.freeze(Object.fromEntries(names.map((name) => [name, address(raw[name])])) as VaultEvidence);
}

function holder(value: unknown): HolderAccount {
  const raw = object(value);
  keys(raw, ['tokenAccount', 'ownerWallet', 'balanceRaw', 'dev', 'bot', 'claimedVault'],
    ['vaultEvidence']);
  if (typeof raw.claimedVault !== 'boolean' ||
      (!raw.claimedVault && Object.hasOwn(raw, 'vaultEvidence'))) {
    throw new Error('Invalid holder vault claim');
  }
  const result: HolderAccount = {
    tokenAccount: address(raw.tokenAccount), ownerWallet: address(raw.ownerWallet),
    balanceRaw: amount(raw.balanceRaw), dev: nullableBoolean(raw.dev),
    bot: nullableBoolean(raw.bot), claimedVault: raw.claimedVault
  };
  return Object.freeze(Object.hasOwn(raw, 'vaultEvidence')
    ? { ...result, vaultEvidence: vaultEvidence(raw.vaultEvidence) } : result);
}

function holderFrame(value: unknown): HolderFrame {
  const raw = object(value);
  keys(raw, ['observedAt', 'supplyRaw', 'previousObservedAt', 'previousHolderCount', 'accounts']);
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 500) throw new Error('Invalid holder list');
  const accounts = raw.accounts.map(holder);
  if (new Set(accounts.map((item) => item.tokenAccount)).size !== accounts.length) {
    throw new Error('Duplicate holder account');
  }
  const supplyRaw = amount(raw.supplyRaw);
  if (accounts.reduce((sum, item) => sum + BigInt(item.balanceRaw), 0n) > BigInt(supplyRaw)) {
    throw new Error('Holder balance exceeds supply');
  }
  if ((raw.previousObservedAt === null) !== (raw.previousHolderCount === null)) {
    throw new Error('Misaligned holder history');
  }
  return Object.freeze({ observedAt: parseIsoTime(raw.observedAt), supplyRaw,
    previousObservedAt: raw.previousObservedAt === null ? null : parseIsoTime(raw.previousObservedAt),
    previousHolderCount: raw.previousHolderCount === null ? null : count(raw.previousHolderCount),
    accounts: Object.freeze(accounts) });
}

function liquidityPoint(value: unknown): LiquidityPoint {
  const raw = object(value);
  keys(raw, ['poolId', 'quoteMint', 'observedAt', 'quoteReserveRaw']);
  return Object.freeze({ poolId: address(raw.poolId), quoteMint: address(raw.quoteMint),
    observedAt: parseIsoTime(raw.observedAt), quoteReserveRaw: amount(raw.quoteReserveRaw) });
}

function liquidityFrame(value: unknown): LiquidityFrame {
  const raw = object(value);
  keys(raw, ['poolId', 'quoteMint', 'observedAt', 'quoteReserveRaw', 'previous']);
  return Object.freeze({ ...liquidityPoint({ poolId: raw.poolId,
    quoteMint: raw.quoteMint, observedAt: raw.observedAt,
    quoteReserveRaw: raw.quoteReserveRaw }),
    previous: raw.previous === null ? null : liquidityPoint(raw.previous) });
}

// Exact schema keeps arbitrary metadata, prompts, URLs, and secrets out of the
// feature engine. Input is one aligned pool/quote/time frame, not a trending list.
export function parseFeatureFrame(value: unknown): FeatureFrame {
  const raw = object(value);
  keys(raw, ['version', 'candidateId', 'mint', 'sourceId', 'evidenceId', 'observedAt',
    'coverageBps', 'confidenceBps', 'poolId', 'quoteMint', 'quoteDecimals', 'current', 'previous',
    'wallets', 'holders', 'liquidity']);
  if (raw.version !== 1) throw new Error('Unsupported feature frame');
  const current = window(raw.current);
  const previous = raw.previous === null ? null : window(raw.previous);
  if (current.to !== parseIsoTime(raw.observedAt) ||
      (previous && (previous.to !== current.from ||
        Date.parse(previous.to) - Date.parse(previous.from) !==
          Date.parse(current.to) - Date.parse(current.from)))) {
    throw new Error('Misaligned feature windows');
  }
  const trades = [...current.trades, ...(previous?.trades ?? [])];
  if (new Set(trades.map((item) => item.id)).size !== trades.length) {
    throw new Error('Duplicate trade evidence');
  }
  const wallets = raw.wallets === null ? null : (() => {
    if (!Array.isArray(raw.wallets) || raw.wallets.length > 200) throw new Error('Invalid wallet facts');
    const parsed = raw.wallets.map(wallet);
    if (new Set(parsed.map((item) => item.wallet)).size !== parsed.length) {
      throw new Error('Duplicate wallet fact');
    }
    return Object.freeze(parsed);
  })();
  const mint = address(raw.mint);
  const poolId = address(raw.poolId);
  const quoteMint = address(raw.quoteMint);
  const market = parseMarketContext({ poolId, quoteMint, quoteDecimals: raw.quoteDecimals,
    windowFrom: current.from, windowTo: current.to });
  if (mint === quoteMint || mint === poolId || raw.candidateId !== `solana:${mint}`) {
    throw new Error('Invalid feature pair');
  }
  const liquidity = raw.liquidity === null ? null : liquidityFrame(raw.liquidity);
  if (liquidity && (liquidity.poolId !== poolId || liquidity.quoteMint !== quoteMint ||
      (liquidity.previous && (liquidity.previous.poolId !== poolId ||
        liquidity.previous.quoteMint !== quoteMint)))) {
    throw new Error('Liquidity pool or quote changed');
  }
  if (liquidity && (liquidity.observedAt !== current.to ||
      (liquidity.previous && liquidity.previous.observedAt !== previous?.to))) {
    throw new Error('Misaligned liquidity history');
  }
  const holders = raw.holders === null ? null : holderFrame(raw.holders);
  if (holders && (holders.observedAt !== current.to ||
      (holders.previousObservedAt && holders.previousObservedAt !== previous?.to))) {
    throw new Error('Misaligned holder history');
  }
  return Object.freeze({ version: 1, candidateId: id(raw.candidateId), mint,
    sourceId: id(raw.sourceId), evidenceId: id(raw.evidenceId, 48),
    observedAt: current.to, coverageBps: parseBasisPoints(raw.coverageBps),
    confidenceBps: parseBasisPoints(raw.confidenceBps), poolId, quoteMint,
    quoteDecimals: market.quoteDecimals,
    current, previous, wallets,
    holders, liquidity });
}
