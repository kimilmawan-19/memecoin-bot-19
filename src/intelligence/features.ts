import { createHash } from 'node:crypto';
import { PUMPSWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../discovery/parse-transaction.ts';
import { parseObservation, type Observation } from './normalize.ts';
import type { FeatureFrame, FeatureTrade, HolderAccount, VaultEvidence } from './feature-frame.ts';

export const FEATURE_VERSION = 'feature-v1';
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const POOL_PROGRAMS = new Set([PUMPSWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM]);
type Values = Record<string, string | number | null>;

function bps(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n || numerator < 0n) return null;
  const result = numerator * 10_000n / denominator;
  return result <= 10_000n ? Number(result) : null;
}

function ratioBps(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n || numerator < 0n) return null;
  const result = numerator * 10_000n / denominator;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function changeBps(current: bigint, previous: bigint): number | null {
  if (previous <= 0n) return null;
  const result = (current - previous) * 10_000n / previous;
  return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(result) : null;
}

function volume(trades: readonly FeatureTrade[], side?: 'BUY' | 'SELL'): bigint {
  return trades.reduce((sum, item) => sum +
    (side === undefined || item.side === side ? BigInt(item.quoteRaw) : 0n), 0n);
}

function uniqueBuyers(trades: readonly FeatureTrade[]): Set<string> {
  return new Set(trades.filter((item) => item.side === 'BUY').map((item) => item.wallet));
}

function funderClusters(wallets: ReadonlyMap<string, { funder: string | null }>,
  buyers: ReadonlySet<string>): number | null {
  const groups = new Map<string, number>();
  for (const buyer of buyers) {
    const funder = wallets.get(buyer)?.funder;
    if (!funder) return null;
    groups.set(funder, (groups.get(funder) ?? 0) + 1);
  }
  return [...groups.values()].filter((count) => count >= 2).length;
}

function repeatedBuyBps(trades: readonly FeatureTrade[]): number | null {
  const buys = trades.filter((item) => item.side === 'BUY');
  const total = volume(buys);
  if (total <= 0n) return null;
  const groups = new Map<string, Set<string>>();
  for (const item of buys) {
    const members = groups.get(item.quoteRaw) ?? new Set<string>();
    members.add(item.wallet);
    groups.set(item.quoteRaw, members);
  }
  const repeated = buys.filter((item) => (groups.get(item.quoteRaw)?.size ?? 0) >= 3);
  return bps(volume(repeated), total);
}

function roundTrips(trades: readonly FeatureTrade[]): number {
  const buys = new Map<string, Set<string>>();
  const sells = new Map<string, Set<string>>();
  for (const item of trades) {
    const group = item.side === 'BUY' ? buys : sells;
    const sizes = group.get(item.wallet) ?? new Set<string>();
    sizes.add(item.quoteRaw);
    group.set(item.wallet, sizes);
  }
  return [...buys].filter(([wallet, sizes]) =>
    [...sizes].some((size) => sells.get(wallet)?.has(size))).length;
}

function bundleConcentration(trades: readonly FeatureTrade[]): number | null {
  const total = volume(trades);
  if (total <= 0n || trades.some((item) => !Object.hasOwn(item, 'bundleId'))) return null;
  const bundles = new Map<string, bigint>();
  for (const item of trades) {
    if (item.bundleId === null || item.bundleId === undefined) continue;
    bundles.set(item.bundleId, (bundles.get(item.bundleId) ?? 0n) + BigInt(item.quoteRaw));
  }
  const largest = [...bundles.values()].reduce((max, value) => value > max ? value : max, 0n);
  return bps(largest, total);
}

function walletValues(frame: FeatureFrame): Values {
  const facts = new Map(frame.wallets?.map((item) => [item.wallet, item]) ?? []);
  const buyers = uniqueBuyers(frame.current.trades);
  const repeatedBuyPatternBps = repeatedBuyBps(frame.current.trades);
  const freshWalletBps = [...buyers].every((wallet) => facts.get(wallet)?.ageDays !== null &&
    facts.has(wallet)) && buyers.size > 0
    ? bps(BigInt([...buyers].filter((wallet) => (facts.get(wallet)?.ageDays ?? 100_001) <= 7).length),
      BigInt(buyers.size)) : null;
  const smartMoneyPresence = [...buyers].every((wallet) =>
    facts.get(wallet)?.smartMoney !== null && facts.has(wallet))
    ? [...buyers].filter((wallet) => facts.get(wallet)?.smartMoney === true).length : null;
  return {
    freshWalletBps,
    fundedWalletClusters: frame.wallets === null ? null : funderClusters(facts, buyers),
    repeatedBuyPatternBps,
    smartMoneyPresence: frame.wallets === null ? null : smartMoneyPresence
  };
}

function organicValues(frame: FeatureFrame): Values {
  if (frame.wallets === null) return {};
  const facts = new Map(frame.wallets.map((item) => [item.wallet, item]));
  const trades = [...frame.current.trades, ...(frame.previous?.trades ?? [])];
  const participants = new Set(trades.map((item) => item.wallet));
  if ([...participants].some((wallet) => !facts.has(wallet) ||
      facts.get(wallet)?.bot === null || facts.get(wallet)?.funder === null)) return {};
  const groups = new Map<string, Set<string>>();
  for (const wallet of participants) {
    const funder = facts.get(wallet)!.funder!;
    const members = groups.get(funder) ?? new Set<string>();
    members.add(wallet);
    groups.set(funder, members);
  }
  const eligible = new Set([...participants].filter((wallet) =>
    facts.get(wallet)?.bot === false && groups.get(facts.get(wallet)!.funder!)?.size === 1));
  const current = frame.current.trades.filter((item) => eligible.has(item.wallet));
  const previous = frame.previous?.trades.filter((item) => eligible.has(item.wallet)) ?? null;
  const buy = volume(current, 'BUY');
  const sell = volume(current, 'SELL');
  const currentBuyers = uniqueBuyers(current).size;
  const previousBuyers = previous === null ? 0 : uniqueBuyers(previous).size;
  return {
    organicScore: null, // Needs outcome calibration; this count is only a screened proxy.
    organicBuyerCount: currentBuyers,
    organicBuyerGrowthBps: previous === null ? null :
      changeBps(BigInt(currentBuyers), BigInt(previousBuyers)),
    organicBuyVolumeRaw: buy.toString(), organicSellVolumeRaw: sell.toString(),
    organicNetFlowRaw: (buy - sell).toString(),
    organicVolumeAccelerationBps: previous === null ? null :
      changeBps(buy + sell, volume(previous))
  };
}

// A label or large balance alone never proves a pool vault. All account links
// must come from decoded pool/token account state before excluding its balance.
export function verifiedVault(account: HolderAccount, evidence: VaultEvidence | undefined,
  frame: FeatureFrame): boolean {
  return !!evidence && POOL_PROGRAMS.has(evidence.poolProgram) &&
    evidence.poolAccountProgramOwner === evidence.poolProgram &&
    TOKEN_PROGRAMS.has(evidence.tokenAccountProgramOwner) &&
    evidence.poolId === frame.poolId && evidence.poolStateVault === account.tokenAccount &&
    evidence.poolAuthority === account.ownerWallet &&
    evidence.tokenAccountOwner === account.ownerWallet &&
    evidence.tokenAccountMint === frame.mint;
}

function holderValues(frame: FeatureFrame): { holders: Values; botHolderBps: number | null } {
  const snapshot = frame.holders;
  if (!snapshot) return { holders: {}, botHolderBps: null };
  if (snapshot.accounts.some((item) => item.claimedVault &&
      !verifiedVault(item, item.vaultEvidence, frame))) {
    return { holders: {}, botHolderBps: null };
  }
  const vaults = snapshot.accounts.filter((item) => item.claimedVault);
  const complete = snapshot.accounts.reduce((sum, item) => sum +
    BigInt(item.balanceRaw), 0n) === BigInt(snapshot.supplyRaw);
  if (!complete) return { holders: {}, botHolderBps: null };
  const circulating = BigInt(snapshot.supplyRaw) -
    vaults.reduce((sum, item) => sum + BigInt(item.balanceRaw), 0n);
  const accounts = snapshot.accounts.filter((item) => !item.claimedVault);
  const byOwner = new Map<string, bigint>();
  for (const item of accounts) {
    byOwner.set(item.ownerWallet, (byOwner.get(item.ownerWallet) ?? 0n) + BigInt(item.balanceRaw));
  }
  const balances = [...byOwner.values()].filter((value) => value > 0n)
    .sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const top10 = balances.slice(0, 10).reduce((sum, value) => sum + value, 0n);
  const dev = accounts.every((item) => item.dev !== null)
    ? bps(accounts.filter((item) => item.dev).reduce((sum, item) => sum + BigInt(item.balanceRaw), 0n),
      circulating) : null;
  const botHolderBps = accounts.every((item) => item.bot !== null)
    ? bps(accounts.filter((item) => item.bot).reduce((sum, item) => sum + BigInt(item.balanceRaw), 0n),
      circulating) : null;
  return {
    holders: {
      holderGrowthBps: snapshot.previousHolderCount === null ? null :
        changeBps(BigInt(balances.length), BigInt(snapshot.previousHolderCount)),
      top10Bps: bps(top10, circulating), devHoldingBps: dev,
      whaleConcentrationBps: bps(balances[0] ?? 0n, circulating)
    },
    botHolderBps
  };
}

function liquidityValues(frame: FeatureFrame): Values {
  const liquidity = frame.liquidity;
  if (!liquidity) return {};
  const reserve = BigInt(liquidity.quoteReserveRaw);
  return {
    liquidityQuoteRaw: liquidity.quoteReserveRaw,
    liquidityGrowthBps: liquidity.previous === null ? null :
      changeBps(reserve, BigInt(liquidity.previous.quoteReserveRaw)),
    volumeToLiquidityBps: ratioBps(volume(frame.current.trades), reserve),
    priceImpactBps: null // Requires an independently validated executable quote.
  };
}

// One frame produces up to five existing Phase 2 observations. Unsupported or
// unverified metrics stay null; no feature here authorizes a trade.
export function deriveFeatureObservations(frame: FeatureFrame): readonly Observation[] {
  const holder = holderValues(frame);
  const wallet = walletValues(frame);
  const categories: Record<string, Values> = {
    organic: organicValues(frame),
    wallets: wallet,
    manipulation: {
      bundleConcentrationBps: bundleConcentration(frame.current.trades),
      botHolderBps: holder.botHolderBps,
      washTradingProbabilityBps: null,
      commonFunderClusters: wallet.fundedWalletClusters,
      repetitiveTradeSizesBps: wallet.repeatedBuyPatternBps,
      suspiciousRoundTrips: roundTrips(frame.current.trades)
    },
    holders: holder.holders,
    liquidity: liquidityValues(frame)
  };
  const digest = createHash('sha256').update(JSON.stringify(frame)).digest('hex').slice(0, 16);
  return Object.entries(categories).flatMap(([category, values]) => {
    if (Object.values(values).every((value) => value === null || value === undefined)) return [];
    return [parseObservation({
      candidateId: frame.candidateId, sourceId: frame.sourceId,
      market: { poolId: frame.poolId, quoteMint: frame.quoteMint, quoteDecimals: frame.quoteDecimals,
        windowFrom: frame.current.from, windowTo: frame.current.to },
      evidenceId: `${FEATURE_VERSION}:${frame.evidenceId}:${category}:${digest}`,
      observedAt: frame.observedAt, coverageBps: frame.coverageBps,
      confidenceBps: frame.confidenceBps, metrics: { [category]: values }
    })];
  });
}
