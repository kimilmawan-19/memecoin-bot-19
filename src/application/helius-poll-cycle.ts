import { runCycle } from '../cycle.ts';
import { DiscoveryPoller, type DiscoveryCursorState, type DiscoveryRpc } from '../discovery/poll.ts';
import { SOLANA_MAINNET_GENESIS_HASH, type HeliusReadOnlyPort } from '../providers/solana/helius-readonly.ts';

export type HeliusPollCycleResult = Readonly<{
  network: 'solana-mainnet';
  finalizedSlot: number;
  checkpoint: 'initialized' | 'advanced' | 'backfilling';
  signaturesRead: number;
  transactionsRead: number;
  eventsDiscovered: number;
  candidates: number;
  decisions: readonly Readonly<{
    mint: string;
    gate: 'PASS' | 'REJECT' | 'UNKNOWN';
    reasons: readonly string[];
    action: 'SKIP';
    reason: string;
  }>[];
  safety: Readonly<{
    readOnly: true;
    signingEnabled: false;
    transactionsSubmitted: 0;
  }>;
}>;

export type HeliusPollCycle = Readonly<{
  result: HeliusPollCycleResult;
  cursors: DiscoveryCursorState;
}>;

export async function runHeliusPollCycle(
  client: HeliusReadOnlyPort,
  previousCursors: DiscoveryCursorState | null,
  now = new Date(),
  maxBatch = 50
): Promise<HeliusPollCycle> {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid cycle time');
  const status = await client.status();
  if (!Number.isSafeInteger(status.finalizedSlot) || status.finalizedSlot < 0) {
    throw new Error('Invalid Helius slot response');
  }
  if (status.genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
    throw new Error('Helius endpoint is not Solana mainnet');
  }

  let signaturesRead = 0;
  let transactionsRead = 0;
  const measuredRpc: DiscoveryRpc = {
    async signatures(program, limit, before) {
      const page = await client.discovery.signatures(program, limit, before);
      signaturesRead += page.length;
      return page;
    },
    async transaction(signature) {
      const transaction = await client.discovery.transaction(signature);
      if (transaction !== null) transactionsRead++;
      return transaction;
    }
  };
  const poller = new DiscoveryPoller(measuredRpc, maxBatch, previousCursors ?? {});
  const batch = await poller.poll();
  const candidates = batch.candidates.map((candidate) => ({
    mint: candidate.mint,
    observedAt: now.toISOString(),
    source: 'solana' as const,
    risk: {
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      liquidityUsd: null
    }
  }));
  const decisions = runCycle(candidates, now).map((decision) => ({
    mint: decision.mint,
    gate: decision.gate.status,
    reasons: decision.gate.reasons,
    action: decision.decision.action,
    reason: decision.decision.reason
  }));
  const cursors = poller.cursorState();
  const hasBackfill = Object.values(cursors).some((cursor) => cursor.backfill !== null);
  return {
    result: {
      network: 'solana-mainnet',
      finalizedSlot: status.finalizedSlot,
      checkpoint: previousCursors === null ? 'initialized' : hasBackfill ? 'backfilling' : 'advanced',
      signaturesRead,
      transactionsRead,
      eventsDiscovered: batch.events.length,
      candidates: batch.candidates.length,
      decisions,
      safety: { readOnly: true, signingEnabled: false, transactionsSubmitted: 0 }
    },
    cursors
  };
}
