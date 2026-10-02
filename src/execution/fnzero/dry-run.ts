import type {
  DryRunFacts, DryRunTradeRequest, DryRunTradeResult, DryRunTradingAdapter, TradeVenue
} from '../../application/trading-adapter.ts';
import type { BalanceSnapshot, QuoteRequest, QuoteResult } from '../../core/models.ts';
import { parseBaseUnits, parseBasisPoints, parseIsoTime } from '../../core/invariants.ts';
import { validSolanaAddress } from '../../core/address.ts';

export type QuoteFixture = Readonly<{ request: QuoteRequest; result: QuoteResult }>;

// Verified against FnZero sol-trade-sdk 0.1.5 source, commit
// 80c10dac4887ddbc6a729281dd93ea5bbf69ced4. This is deliberately an
// incomplete, inert mapping: no SDK import, signer, RPC, or transaction.
const DEX_TYPES: Readonly<Record<TradeVenue, string>> = Object.freeze({
  pumpfun: 'PumpFun',
  pumpswap: 'PumpSwap',
  bonk: 'Bonk',
  'raydium-cpmm': 'RaydiumCpmm',
  'raydium-amm-v4': 'RaydiumAmmV4',
  'meteora-damm-v2': 'MeteoraDammV2'
});

export type FnzeroPreview = Readonly<{
  method: 'buy' | 'sell';
  dexType: string;
  mint: string;
  inputTokenAmount: number;
  slippageBasisPoints: number;
  missingForExecution: readonly ['quoteTokenType', 'extensionParams', 'recentBlockhash', 'signer',
    'finalInstructionValidation'];
}>;

const MAX_AGE_MS = 5 * 60_000;
const FUTURE_TOLERANCE_MS = 30_000;
const IDENTIFIER = /^[a-zA-Z0-9:._-]{1,128}$/;

function recent(value: string, nowMs: number): boolean {
  const age = nowMs - Date.parse(parseIsoTime(value));
  return age >= -FUTURE_TOLERANCE_MS && age <= MAX_AGE_MS;
}

function positiveSafeAmount(value: unknown): number {
  const raw = parseBaseUnits(value);
  if (raw.length > 16) throw new Error('Amount cannot be represented by FnZero');
  const amount = BigInt(raw);
  if (amount === 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount cannot be represented by FnZero');
  }
  return Number(amount);
}

function boundedUnits(value: unknown): bigint {
  const raw = parseBaseUnits(value);
  if (raw.length > 20) throw new Error('Base-unit amount exceeds u64 range');
  const amount = BigInt(raw);
  if (amount > 18_446_744_073_709_551_615n) {
    throw new Error('Base-unit amount exceeds u64 range');
  }
  return amount;
}

function validQuoteRequest(request: QuoteRequest, nowMs: number): boolean {
  return IDENTIFIER.test(request.id) &&
    validSolanaAddress(request.inputMint) && validSolanaAddress(request.outputMint) &&
    validSolanaAddress(request.poolId) &&
    request.inputMint !== request.outputMint &&
    positiveSafeAmount(request.amountInRaw) > 0 &&
    parseBasisPoints(request.maxSlippageBps) >= 0 &&
    recent(request.requestedAt, nowMs);
}

function validQuote(result: QuoteResult, requestId: string, nowMs: number): boolean {
  const expected = positiveSafeAmount(result.expectedOutputRaw);
  const minimum = positiveSafeAmount(result.minOutputRaw);
  boundedUnits(result.estimatedFeeRaw); // Fee is in lamports for Phase 3 fixtures.
  return result.requestId === requestId && expected >= minimum &&
    result.priceImpactBps !== null && parseBasisPoints(result.priceImpactBps) >= 0 &&
    result.evidenceIds.length > 0 && result.evidenceIds.every((id) => IDENTIFIER.test(id)) &&
    recent(result.observedAt, nowMs) &&
    Date.parse(parseIsoTime(result.expiresAt)) > nowMs &&
    Date.parse(result.expiresAt) <= Date.parse(result.observedAt) + MAX_AGE_MS;
}

function sameRequest(a: QuoteRequest, b: QuoteRequest): boolean {
  return a.id === b.id && a.poolId === b.poolId && a.inputMint === b.inputMint &&
    a.outputMint === b.outputMint && a.amountInRaw === b.amountInRaw &&
    a.maxSlippageBps === b.maxSlippageBps && a.requestedAt === b.requestedAt;
}

export function previewFnzeroMapping(request: DryRunTradeRequest): FnzeroPreview {
  const { intent, venue } = request;
  if ((intent.side !== 'BUY' && intent.side !== 'SELL') ||
      !Object.hasOwn(DEX_TYPES, venue) || !validSolanaAddress(intent.mint)) {
    throw new Error('Unsupported venue or mint');
  }
  return Object.freeze({
    method: intent.side === 'BUY' ? 'buy' : 'sell',
    dexType: DEX_TYPES[venue],
    mint: intent.mint,
    inputTokenAmount: positiveSafeAmount(intent.amountRaw),
    slippageBasisPoints: parseBasisPoints(intent.maxSlippageBps),
    missingForExecution: Object.freeze([
      'quoteTokenType', 'extensionParams', 'recentBlockhash', 'signer',
      'finalInstructionValidation'
    ] as const)
  });
}

export class FnzeroDryRunAdapter implements DryRunTradingAdapter {
  private readonly quotes: readonly QuoteFixture[];
  private readonly balances: readonly BalanceSnapshot[];
  private readonly clock: () => Date;

  constructor(
    quotes: readonly QuoteFixture[],
    balances: readonly BalanceSnapshot[],
    clock: () => Date
  ) {
    this.quotes = quotes;
    this.balances = balances;
    this.clock = clock;
  }

  async quote(request: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const nowMs = this.clock().getTime();
      if (!Number.isFinite(nowMs) || !validQuoteRequest(request, nowMs)) return null;
      const matches = this.quotes.filter((item) => sameRequest(item.request, request));
      if (matches.length !== 1 || !validQuote(matches[0].result, request.id, nowMs)) return null;
      const result = matches[0].result;
      return Object.freeze({
        requestId: result.requestId,
        expectedOutputRaw: result.expectedOutputRaw,
        minOutputRaw: result.minOutputRaw,
        estimatedFeeRaw: result.estimatedFeeRaw,
        priceImpactBps: result.priceImpactBps,
        observedAt: result.observedAt,
        expiresAt: result.expiresAt,
        evidenceIds: Object.freeze([...result.evidenceIds])
      });
    } catch {
      return null;
    }
  }

  async getBalance(walletId: string, mint: string): Promise<BalanceSnapshot | null> {
    try {
      const nowMs = this.clock().getTime();
      if (!Number.isFinite(nowMs) || !IDENTIFIER.test(walletId) ||
          !validSolanaAddress(mint)) return null;
      const matches = this.balances.filter((item) =>
        item.walletId === walletId && item.mint === mint);
      if (matches.length !== 1 || !recent(matches[0].observedAt, nowMs) ||
          !IDENTIFIER.test(matches[0].sourceId)) return null;
      const balance = matches[0];
      boundedUnits(balance.amountRaw);
      return Object.freeze({
        walletId: balance.walletId,
        mint: balance.mint,
        amountRaw: balance.amountRaw,
        observedAt: balance.observedAt,
        sourceId: balance.sourceId
      });
    } catch {
      return null;
    }
  }

  buy(request: DryRunTradeRequest, facts: DryRunFacts): DryRunTradeResult | null {
    return this.preview(request, facts, 'BUY');
  }

  sell(request: DryRunTradeRequest, facts: DryRunFacts): DryRunTradeResult | null {
    return this.preview(request, facts, 'SELL');
  }

  private preview(request: DryRunTradeRequest, facts: DryRunFacts,
    side: 'BUY' | 'SELL'): DryRunTradeResult | null {
    try {
      const nowMs = this.clock().getTime();
      const { intent, quoteRequest, walletId } = request;
      if (!Number.isFinite(nowMs) || !IDENTIFIER.test(walletId) ||
          !IDENTIFIER.test(intent.id) || !IDENTIFIER.test(intent.policyVersion) ||
          intent.side !== side || quoteRequest.maxSlippageBps !== intent.maxSlippageBps ||
          quoteRequest.amountInRaw !== intent.amountRaw ||
          (side === 'BUY' ? quoteRequest.outputMint !== intent.mint :
            quoteRequest.inputMint !== intent.mint) ||
          Date.parse(parseIsoTime(intent.expiresAt)) <= nowMs ||
          Date.parse(intent.expiresAt) > nowMs + MAX_AGE_MS) return null;
      previewFnzeroMapping(request);
      const { quote, balance } = facts;
      if (!validQuoteRequest(quoteRequest, nowMs) || !quote ||
          !validQuote(quote, quoteRequest.id, nowMs) ||
          BigInt(quote.minOutputRaw) < BigInt(positiveSafeAmount(intent.minOutputRaw)) ||
          boundedUnits(quote.estimatedFeeRaw) > boundedUnits(intent.maxFeeRaw)) return null;
      if (!balance || balance.walletId !== walletId || balance.mint !== quoteRequest.inputMint ||
          !IDENTIFIER.test(balance.sourceId) || !recent(balance.observedAt, nowMs) ||
          boundedUnits(balance.amountRaw) < BigInt(intent.amountRaw)) return null;
      return Object.freeze({
        mode: 'DRY_RUN',
        status: 'SIMULATED',
        intentId: intent.id,
        side,
        venue: request.venue,
        quoteRequestId: quote.requestId,
        expectedOutputRaw: quote.expectedOutputRaw,
        minOutputRaw: quote.minOutputRaw,
        estimatedFeeRaw: quote.estimatedFeeRaw,
        signatures: Object.freeze([]) as readonly []
      });
    } catch {
      return null;
    }
  }
}
