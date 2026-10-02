import type { OpenPosition, PositionProposal } from '../../core/models.ts';
import { parsePositionProposal } from '../../core/position-proposal.ts';
import { immutableSnapshot } from '../../core/snapshot.ts';
import type { LlmProvider } from '../../llm/provider.ts';
import type { PositionObservation } from '../../positions/monitor.ts';
import type { ManagerAgent } from '../../application/position-ports.ts';
import { buildManagerMessages, MANAGER_PROMPT_VERSION, MANAGER_SCHEMA } from './prompt.ts';

function parseDecision(value: unknown, evidenceIds: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manager decision');
  const raw = value as Record<string, unknown>;
  const keys = ['action', 'reduceBps', 'rationale', 'evidenceIds'];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      !['HOLD', 'REDUCE', 'EXIT'].includes(raw.action as string) ||
      (raw.action === 'REDUCE' ? !Number.isSafeInteger(raw.reduceBps) ||
        (raw.reduceBps as number) < 1 || (raw.reduceBps as number) > 9999 : raw.reduceBps !== null) ||
      typeof raw.rationale !== 'string' || raw.rationale.length < 1 ||
      raw.rationale.length > 500 || /[\x00-\x1f\x7f]/.test(raw.rationale) ||
      !Array.isArray(raw.evidenceIds) || raw.evidenceIds.length > 20 ||
      raw.evidenceIds.some((item) => typeof item !== 'string' ||
        !/^[a-zA-Z0-9:._-]{1,128}$/.test(item) || !evidenceIds.includes(item)) ||
      new Set(raw.evidenceIds).size !== raw.evidenceIds.length ||
      (raw.action !== 'HOLD' && raw.evidenceIds.length === 0)) {
    throw new Error('Invalid manager decision');
  }
  return raw as { action: PositionProposal['action']; reduceBps: number | null;
    rationale: string; evidenceIds: string[] };
}

export class LlmManagerAgent implements ManagerAgent {
  private readonly provider: LlmProvider;
  private readonly modelVersion: string;
  private readonly clock: () => Date;

  constructor(provider: LlmProvider, modelVersion: string, clock: () => Date) {
    if (!/^[a-zA-Z0-9:._-]{1,128}$/.test(modelVersion)) throw new Error('Invalid model version');
    this.provider = provider;
    this.modelVersion = modelVersion;
    this.clock = clock;
  }

  async propose(position: OpenPosition, observation: PositionObservation,
    signal?: AbortSignal): Promise<PositionProposal> {
    const stable = immutableSnapshot({ position, observation });
    const output = parseDecision(await this.provider.completeJson(
      buildManagerMessages(stable.position, stable.observation), MANAGER_SCHEMA, signal),
    stable.observation.evidenceIds);
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid manager clock');
    return parsePositionProposal({
      positionId: stable.position.id, positionVersion: stable.position.version,
      snapshotId: stable.observation.snapshotId,
      action: output.action, reduceBps: output.reduceBps, rationale: output.rationale,
      evidenceIds: output.evidenceIds, modelVersion: this.modelVersion,
      promptVersion: MANAGER_PROMPT_VERSION,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
  }
}
