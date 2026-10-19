import { DiscoveryIndex, type DiscoveryBatch, type DiscoveryEvent } from './events.ts';
import { parseDiscoveryTransaction, PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from './parse-transaction.ts';

export type SignatureInfo = Readonly<{ signature: string; slot: number; err: unknown }>;

export interface DiscoveryRpc {
  signatures(program: string, limit: number, before?: string): Promise<readonly SignatureInfo[]>;
  transaction(signature: string): Promise<unknown | null>;
}

export type DiscoveryBackfill = Readonly<{
  anchor: string | null;
  targetHead: string;
  before: string;
}>;

export type DiscoveryProgramCursor = Readonly<{
  cursor: string | null;
  backfill: DiscoveryBackfill | null;
}>;

export type DiscoveryCursorState = Readonly<Record<string, DiscoveryProgramCursor>>;

// Slots covered by one program in the last successful poll. A healthy backfill
// keeps moving oldestSlot down toward anchorSlot; signatures are never exposed.
export type DiscoveryProgramProgress = Readonly<{
  program: string;
  backfilling: boolean;
  newestSlot: number | null;
  oldestSlot: number | null;
  anchorSlot: number | null;
}>;

const PROGRAMS = [PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM] as const;

// Explicit finalized polling. Missing cursors bootstrap at the current head;
// stored backfill state lets later runs walk older finalized pages safely.
export class DiscoveryPoller {
  private readonly cursors = new Map<string, DiscoveryProgramCursor>();
  private readonly index = new DiscoveryIndex();
  private lastProgress: readonly DiscoveryProgramProgress[] = [];
  private busy = false;
  private readonly rpc: DiscoveryRpc;
  private readonly maxBatch: number;

  constructor(rpc: DiscoveryRpc, maxBatch = 50, initialCursors: DiscoveryCursorState = {}) {
    if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) {
      throw new Error('Invalid discovery batch limit');
    }
    for (const [program, state] of Object.entries(initialCursors)) {
      if (!(PROGRAMS as readonly string[]).includes(program) || !validProgramCursor(state)) {
        throw new Error('Invalid discovery cursor state');
      }
      this.cursors.set(program, state);
    }
    this.rpc = rpc;
    this.maxBatch = maxBatch;
  }

  cursorState(): DiscoveryCursorState {
    return Object.fromEntries(this.cursors);
  }

  progress(): readonly DiscoveryProgramProgress[] {
    return this.lastProgress;
  }

  async poll(): Promise<DiscoveryBatch> {
    if (this.busy) throw new Error('Discovery poll already running');
    this.busy = true;
    try {
      const next = new Map(this.cursors);
      const pending: SignatureInfo[] = [];
      const progress: DiscoveryProgramProgress[] = [];
      const limit = this.maxBatch + 1;
      // Call after next.set(program, ...): queues the covered rows and records their slots.
      const take = (program: string, covered: readonly SignatureInfo[], anchorSlot: number | null = null) => {
        pending.push(...covered.filter((item) => item.err === null));
        progress.push({
          program,
          backfilling: Boolean(next.get(program)?.backfill),
          newestSlot: covered[0]?.slot ?? null,
          oldestSlot: covered[covered.length - 1]?.slot ?? null,
          anchorSlot
        });
      };
      for (const program of PROGRAMS) {
        const state = this.cursors.get(program);
        const page = await this.rpc.signatures(program, limit, state?.backfill?.before);
        validatePage(page, limit);
        if (!state) {
          next.set(program, { cursor: page[0]?.signature ?? null, backfill: null });
          take(program, []);
          continue;
        }
        if (page.length === 0) {
          if (state.backfill) throw new Error('Discovery cursor gap; backfill required');
          take(program, []);
          continue;
        }
        if (state.backfill) {
          const anchor = state.backfill.anchor;
          const anchorSlot = anchor === null ? null :
            (page.find((item) => item.signature === anchor)?.slot ?? await this.signatureSlot(anchor));
          take(program, this.collectBackfill(program, state, page, limit, anchorSlot, next), anchorSlot);
          continue;
        }
        if (state.cursor === null) {
          const targetHead = page[0].signature;
          if (page.length <= this.maxBatch) {
            next.set(program, { cursor: targetHead, backfill: null });
            take(program, page);
          } else {
            const processed = page.slice(0, this.maxBatch);
            next.set(program, {
              cursor: null,
              backfill: { anchor: null, targetHead, before: processed[processed.length - 1].signature }
            });
            take(program, processed);
          }
          continue;
        }
        const cursorIndex = page.findIndex((item) => item.signature === state.cursor);
        if (cursorIndex >= 0) {
          next.set(program, { cursor: page[0].signature, backfill: null });
          take(program, page.slice(0, cursorIndex));
          continue;
        }
        const anchorSlot = await this.signatureSlot(state.cursor);
        assertAnchorNotPassed(page, anchorSlot);
        const targetHead = page[0].signature;
        const processed = page.slice(0, this.maxBatch);
        next.set(program, {
          cursor: state.cursor,
          backfill: { anchor: state.cursor, targetHead, before: processed[processed.length - 1].signature }
        });
        take(program, processed, anchorSlot);
      }
      const unique = new Map<string, SignatureInfo>();
      for (const item of pending) {
        const previous = unique.get(item.signature);
        if (previous && previous.slot !== item.slot) throw new Error('Discovery signature slot mismatch');
        unique.set(item.signature, item);
      }
      const ordered = [...unique.values()].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
      const events: DiscoveryEvent[] = [];
      for (const item of ordered) {
        const raw = await this.rpc.transaction(item.signature);
        if (raw === null) throw new Error('Discovery transaction unavailable; retry later');
        if (!raw || typeof raw !== 'object' || !('slot' in raw) || raw.slot !== item.slot) {
          throw new Error('Discovery transaction mismatch');
        }
        events.push(...parseDiscoveryTransaction(raw, item.signature));
      }
      const result = this.index.ingest(events);
      this.cursors.clear();
      for (const [program, cursor] of next) this.cursors.set(program, cursor);
      this.lastProgress = progress;
      return result;
    } finally {
      this.busy = false;
    }
  }

  // Returns the rows this page covers; the caller queues them.
  private collectBackfill(
    program: string,
    state: DiscoveryProgramCursor,
    page: readonly SignatureInfo[],
    limit: number,
    anchorSlot: number | null,
    next: Map<string, DiscoveryProgramCursor>
  ): readonly SignatureInfo[] {
    const backfill = state.backfill;
    if (!backfill) throw new Error('Invalid discovery cursor state');
    const anchorIndex = backfill.anchor === null ? -1 :
      page.findIndex((item) => item.signature === backfill.anchor);
    const anchorReached = backfill.anchor !== null && anchorIndex >= 0;
    const emptyBoundaryReached = backfill.anchor === null && page.length < limit;
    if (anchorReached) {
      next.set(program, { cursor: backfill.targetHead, backfill: null });
      return page.slice(0, anchorIndex);
    }
    if (emptyBoundaryReached) {
      next.set(program, { cursor: backfill.targetHead, backfill: null });
      return page;
    }
    if (page.length === 0) throw new Error('Discovery cursor gap; backfill required');
    if (anchorSlot !== null) assertAnchorNotPassed(page, anchorSlot);
    const processed = page.slice(0, this.maxBatch);
    next.set(program, {
      cursor: state.cursor,
      backfill: { ...backfill, before: processed[processed.length - 1].signature }
    });
    return processed;
  }

  // Slot of a checkpoint signature that is not on the current page. Failed
  // transactions are valid anchors, so only the envelope is checked.
  private async signatureSlot(signature: string): Promise<number> {
    const raw = await this.rpc.transaction(signature);
    if (raw === null) throw new Error('Discovery anchor unavailable; retry later');
    const tx = record(raw);
    const transaction = record(tx?.transaction);
    if (!tx || !transaction || !Number.isSafeInteger(tx.slot) || (tx.slot as number) < 0 ||
        !Array.isArray(transaction.signatures) || transaction.signatures[0] !== signature) {
      throw new Error('Discovery transaction mismatch');
    }
    return tx.slot as number;
  }
}

// Pages descend by slot, so a row older than the anchor's slot means the anchor
// was skipped. Walking further would never terminate; fail closed instead.
function assertAnchorNotPassed(page: readonly SignatureInfo[], anchorSlot: number): void {
  if (page.length > 0 && page[page.length - 1].slot < anchorSlot) {
    throw new Error('Discovery backfill passed its anchor; review required');
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function validatePage(page: readonly SignatureInfo[], limit: number): void {
  if (page.length > limit || new Set(page.map((item) => item.signature)).size !== page.length ||
      page.some((item, index) => index > 0 && item.slot > page[index - 1].slot)) {
    throw new Error('Invalid discovery signature page');
  }
}

function validProgramCursor(value: unknown): value is DiscoveryProgramCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).sort().join(',') !== 'backfill,cursor' ||
      (state.cursor !== null && typeof state.cursor !== 'string')) return false;
  if (state.backfill === null) return true;
  if (!state.backfill || typeof state.backfill !== 'object' || Array.isArray(state.backfill)) return false;
  const backfill = state.backfill as Record<string, unknown>;
  return Object.keys(backfill).sort().join(',') === 'anchor,before,targetHead' &&
    (backfill.anchor === null || typeof backfill.anchor === 'string') &&
    typeof backfill.before === 'string' && typeof backfill.targetHead === 'string';
}
