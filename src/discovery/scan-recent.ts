import { DiscoveryIndex, type DiscoveryBatch, type DiscoveryEvent } from './events.ts';
import { parseDiscoveryTransaction, PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from './parse-transaction.ts';
import type { DiscoveryRpc, SignatureInfo } from './poll.ts';

export type RecentDiscoveryScan = DiscoveryBatch & Readonly<{
  signaturesRead: number;
  transactionsRead: number;
}>;

const PROGRAMS = [PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM] as const;

// One bounded snapshot of recent finalized activity. This is not a continuous
// poller and makes no claim to backfill events older than the requested page.
export async function scanRecentDiscovery(rpc: DiscoveryRpc, limitPerProgram = 5): Promise<RecentDiscoveryScan> {
  if (!Number.isInteger(limitPerProgram) || limitPerProgram < 1 || limitPerProgram > 10) {
    throw new Error('Invalid recent discovery limit');
  }
  const events: DiscoveryEvent[] = [];
  let signaturesRead = 0;
  let transactionsRead = 0;
  for (const program of PROGRAMS) {
    const page = await rpc.signatures(program, limitPerProgram);
    if (page.length > limitPerProgram || new Set(page.map((item) => item.signature)).size !== page.length ||
        page.some((item, index) => !validSignatureInfo(item) ||
          (index > 0 && item.slot > page[index - 1].slot))) {
      throw new Error('Invalid recent discovery page');
    }
    signaturesRead += page.length;
    for (const item of page) {
      if (item.err !== null) continue;
      const raw = await rpc.transaction(item.signature);
      if (!raw || typeof raw !== 'object' || !('slot' in raw) || raw.slot !== item.slot) {
        throw new Error('Recent discovery transaction unavailable or mismatched');
      }
      transactionsRead++;
      events.push(...parseDiscoveryTransaction(raw, item.signature));
    }
  }
  const batch = new DiscoveryIndex().ingest(events);
  return { ...batch, signaturesRead, transactionsRead };
}

function validSignatureInfo(item: SignatureInfo): boolean {
  return typeof item.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature) &&
    Number.isSafeInteger(item.slot) && item.slot >= 0 &&
    (item.err === null || (typeof item.err === 'object' && item.err !== null && !Array.isArray(item.err)));
}
