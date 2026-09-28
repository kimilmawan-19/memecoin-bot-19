import type { TokenCandidate } from '../core/models.ts';

export type DiscoveryEvent = Readonly<{
  kind: 'TOKEN_CREATED' | 'PUMPSWAP_MIGRATED' | 'RAYDIUM_POOL_CREATED';
  sourceId: 'pumpfun' | 'raydium-cpmm';
  mint: string;
  pool: string | null;
  slot: number;
  occurredAt: string;
  evidenceId: string;
}>;

export type DiscoveryBatch = Readonly<{
  candidates: readonly TokenCandidate[];
  events: readonly DiscoveryEvent[];
}>;

// In-memory replay view. Durable cursors and candidate storage belong to a later phase.
export class DiscoveryIndex {
  private readonly candidates = new Map<string, TokenCandidate>();
  private readonly seen = new Set<string>();

  ingest(events: readonly DiscoveryEvent[]): DiscoveryBatch {
    const unique = new Set(events.map((event) => event.evidenceId));
    const newIds = new Set([...unique].filter((id) => !this.seen.has(id)));
    const newMints = new Set(events.filter((event) => newIds.has(event.evidenceId))
      .map((event) => event.mint).filter((mint) => !this.candidates.has(mint)));
    if (this.seen.size + newIds.size > 10_000 ||
        this.candidates.size + newMints.size > 10_000) {
      throw new Error('Discovery index capacity reached');
    }
    const accepted: DiscoveryEvent[] = [];
    const changed = new Map<string, TokenCandidate>();
    for (const event of events) {
      if (this.seen.has(event.evidenceId)) continue;
      this.seen.add(event.evidenceId);
      accepted.push(event);
      const prior = this.candidates.get(event.mint);
      const candidate: TokenCandidate = prior ? {
        ...prior,
        discoveredAt: event.occurredAt < prior.discoveredAt ? event.occurredAt : prior.discoveredAt,
        sourceId: event.occurredAt < prior.discoveredAt ? event.sourceId : prior.sourceId,
        evidenceIds: [...prior.evidenceIds, event.evidenceId]
      } : {
        id: `solana:${event.mint}`,
        chain: 'solana',
        mint: event.mint,
        discoveredAt: event.occurredAt,
        sourceId: event.sourceId,
        evidenceIds: [event.evidenceId]
      };
      this.candidates.set(event.mint, candidate);
      changed.set(event.mint, candidate);
    }
    return { candidates: [...changed.values()], events: accepted };
  }

  get(mint: string): TokenCandidate | undefined {
    return this.candidates.get(mint);
  }
}
