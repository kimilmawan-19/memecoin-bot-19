import type { ClosedTrade, OpenPosition } from '../core/models.ts';
import { parseIsoTime, parseSignedBaseUnits } from '../core/invariants.ts';
import { validSolanaAddress } from '../core/address.ts';
import { id, units } from '../risk/policy.ts';

// A normalized, confirmed fixture proof. SUBMITTED/UNKNOWN adapter receipts
// must never be passed here. A live reconciler must verify chain state first.
export type ConfirmedSellFill = Readonly<{
  sourceKind: 'FIXTURE';
  sourceId: string;
  positionId: string;
  positionVersion: number;
  intentId: string;
  // True only when reconciliation proves no part of this order remains active.
  orderFinal: boolean;
  signature: string;
  filledQuantityRaw: string;
  proceedsQuoteRaw: string;
  feeQuoteRaw: string;
  balanceAfterRaw: string;
  confirmedAt: string;
  evidenceIds: readonly string[];
}>;

export type ReconciledSell = Readonly<{
  remaining: OpenPosition | null;
  closedTrade: ClosedTrade | null;
  realizedPnlQuoteRaw: string;
}>;

export function reconcileConfirmedSell(position: OpenPosition,
  fill: ConfirmedSellFill, now: Date): ReconciledSell {
  if (!Number.isFinite(now.getTime()) || fill.sourceKind !== 'FIXTURE' ||
      fill.positionId !== position.id || fill.positionVersion !== position.version ||
      (position.status !== 'EXIT_PENDING' && position.status !== 'UNRESOLVED') ||
      fill.intentId !== position.exitIntentId ||
      typeof fill.orderFinal !== 'boolean' ||
      !validSolanaAddress(position.mint) ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(fill.signature) ||
      !Number.isSafeInteger(position.version) || position.version < 0 ||
      !Array.isArray(fill.evidenceIds) ||
      fill.evidenceIds.length === 0 || fill.evidenceIds.length > 20 ||
      new Set(fill.evidenceIds).size !== fill.evidenceIds.length) {
    throw new Error('Unverified sell fill');
  }
  id(position.id);
  id(position.walletId);
  id(fill.intentId);
  id(fill.sourceId);
  fill.evidenceIds.forEach(id);
  const confirmedAt = parseIsoTime(fill.confirmedAt);
  if (Date.parse(confirmedAt) < Date.parse(parseIsoTime(position.openedAt)) ||
      Date.parse(confirmedAt) > now.getTime()) throw new Error('Unverified sell fill');
  const quantity = units(position.quantityRaw);
  const filled = units(fill.filledQuantityRaw);
  const remainingQuantity = units(fill.balanceAfterRaw);
  const cost = units(position.costQuoteRaw);
  const peak = units(position.peakValueQuoteRaw);
  const proceeds = units(fill.proceedsQuoteRaw);
  const fee = units(fill.feeQuoteRaw);
  const priorRealized = BigInt(parseSignedBaseUnits(position.realizedPnlQuoteRaw));
  if (quantity === 0n || cost === 0n || peak < cost ||
      filled === 0n || filled > quantity ||
      remainingQuantity !== quantity - filled || proceeds === 0n || fee > proceeds) {
    throw new Error('Unverified sell fill');
  }
  const soldCost = cost * filled / quantity;
  const realized = (proceeds - fee - soldCost).toString();
  const cumulativeRealized = (priorRealized + BigInt(realized)).toString();
  if (remainingQuantity === 0n) {
    if (!fill.orderFinal) throw new Error('Unverified sell fill');
    return Object.freeze({ remaining: null,
      closedTrade: Object.freeze({ id: `${position.id}:close:${position.version}`,
        positionId: position.id, openedAt: position.openedAt,
        closedAt: confirmedAt, realizedPnlQuoteRaw: cumulativeRealized,
        reconciled: true, evidenceIds: Object.freeze([...fill.evidenceIds]) }),
      realizedPnlQuoteRaw: realized });
  }
  const remainingCost = cost - soldCost;
  const remainingPeak = peak * remainingQuantity / quantity;
  if (remainingCost === 0n || position.version >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Unverified sell fill');
  }
  return Object.freeze({
    remaining: Object.freeze({ ...position, quantityRaw: remainingQuantity.toString(),
      costQuoteRaw: remainingCost.toString(),
      peakValueQuoteRaw: (remainingPeak > remainingCost ? remainingPeak : remainingCost).toString(),
      realizedPnlQuoteRaw: cumulativeRealized,
      status: fill.orderFinal ? 'OPEN' as const : position.status,
      exitIntentId: fill.orderFinal ? null : position.exitIntentId,
      version: position.version + 1 }),
    closedTrade: null, realizedPnlQuoteRaw: realized
  });
}
