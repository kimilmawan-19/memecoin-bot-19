import { DiscoveryIndex, type DiscoveryBatch, type DiscoveryEvent } from './events.ts';
import { parseDiscoveryTransaction, PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from './parse-transaction.ts';

export type SignatureInfo = Readonly<{ signature: string; slot: number; err: unknown }>;

export interface DiscoveryRpc {
  signatures(program: string, limit: number): Promise<readonly SignatureInfo[]>;
  transaction(signature: string): Promise<unknown | null>;
}

const PROGRAMS = [PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM] as const;

// Explicit polling only. A new process bootstraps at the current head rather
// than pretending to have a durable cursor or silently backfilling history.
export class DiscoveryPoller {
  private readonly cursors = new Map<string, string>();
  private readonly index = new DiscoveryIndex();
  private busy = false;
  private readonly rpc: DiscoveryRpc;
  private readonly maxBatch: number;

  constructor(rpc: DiscoveryRpc, maxBatch = 50) {
    if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) {
      throw new Error('Invalid discovery batch limit');
    }
    this.rpc = rpc;
    this.maxBatch = maxBatch;
  }

  async poll(): Promise<DiscoveryBatch> {
    if (this.busy) throw new Error('Discovery poll already running');
    this.busy = true;
    try {
      const next = new Map(this.cursors);
      const pending: SignatureInfo[] = [];
      for (const program of PROGRAMS) {
        const page = await this.rpc.signatures(program, this.maxBatch + 1);
        if (page.length > this.maxBatch + 1 || new Set(page.map((x) => x.signature)).size !== page.length) {
          throw new Error('Invalid discovery signature page');
        }
        if (page.some((item, i) => i > 0 && item.slot > page[i - 1].slot)) {
          throw new Error('Invalid discovery signature order');
        }
        if (page.length === 0) continue;
        const cursor = this.cursors.get(program);
        if (cursor === undefined) {
          next.set(program, page[0].signature);
          continue;
        }
        const cursorIndex = page.findIndex((x) => x.signature === cursor);
        if (cursorIndex < 0) throw new Error('Discovery cursor gap; backfill required');
        if (cursorIndex > this.maxBatch) throw new Error('Discovery backpressure limit reached');
        pending.push(...page.slice(0, cursorIndex).filter((x) => x.err === null));
        next.set(program, page[0].signature);
      }
      const unique = new Map<string, SignatureInfo>();
      for (const item of pending) {
        const previous = unique.get(item.signature);
        if (previous && previous.slot !== item.slot) throw new Error('Discovery signature slot mismatch');
        unique.set(item.signature, item);
      }
      if (unique.size > this.maxBatch) throw new Error('Discovery backpressure limit reached');
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
      return result;
    } finally {
      this.busy = false;
    }
  }
}
