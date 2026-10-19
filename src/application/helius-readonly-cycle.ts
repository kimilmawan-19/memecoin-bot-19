import { runCycle } from '../cycle.ts';
import { scanRecentDiscovery } from '../discovery/scan-recent.ts';
import { SOLANA_MAINNET_GENESIS_HASH, type HeliusReadOnlyPort } from '../providers/solana/helius-readonly.ts';

export type HeliusReadOnlyCycleResult = Readonly<{
  network: 'solana-mainnet';
  finalizedSlot: number;
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

export async function runHeliusReadOnlyCycle(
  client: HeliusReadOnlyPort,
  now = new Date(),
  limitPerProgram = 5
): Promise<HeliusReadOnlyCycleResult> {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid cycle time');
  const status = await client.status();
  if (!Number.isSafeInteger(status.finalizedSlot) || status.finalizedSlot < 0) {
    throw new Error('Invalid Helius slot response');
  }
  if (status.genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
    throw new Error('Helius endpoint is not Solana mainnet');
  }
  const scan = await scanRecentDiscovery(client.discovery, limitPerProgram);
  const candidates = scan.candidates.map((candidate) => ({
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
  return {
    network: 'solana-mainnet',
    finalizedSlot: status.finalizedSlot,
    signaturesRead: scan.signaturesRead,
    transactionsRead: scan.transactionsRead,
    eventsDiscovered: scan.events.length,
    candidates: scan.candidates.length,
    decisions,
    safety: { readOnly: true, signingEnabled: false, transactionsSubmitted: 0 }
  };
}
