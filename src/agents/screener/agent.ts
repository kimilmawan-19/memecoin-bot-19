import type { ScreenerAgent } from '../../application/ports.ts';
import type { Lesson, ScreenerProposal, TokenCandidate, TokenIntelligence } from '../../core/models.ts';
import { parseScreenerProposal } from '../../core/proposal.ts';
import { immutableSnapshot } from '../../core/snapshot.ts';
import type { LlmProvider } from '../../llm/provider.ts';
import { buildScreenerMessages, PROMPT_VERSION, SCREENER_SCHEMA } from './prompt.ts';

const ID = /^[a-zA-Z0-9:._-]{1,128}$/;

function parseDecision(value: unknown, allowedEvidence: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid screener decision');
  }
  const raw = value as Record<string, unknown>;
  const keys = ['action', 'rationale', 'risks', 'evidenceIds'];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      (raw.action !== 'BUY' && raw.action !== 'SKIP') ||
      typeof raw.rationale !== 'string' || raw.rationale.length < 1 ||
      raw.rationale.length > 500 || /[\x00-\x1f\x7f]/.test(raw.rationale) ||
      !Array.isArray(raw.risks) || raw.risks.length > 20 ||
      !Array.isArray(raw.evidenceIds) || raw.evidenceIds.length > 20 ||
      raw.risks.some((risk) => typeof risk !== 'string' || !ID.test(risk)) ||
      raw.evidenceIds.some((evidence) => typeof evidence !== 'string' ||
        !ID.test(evidence) || !allowedEvidence.includes(evidence)) ||
      new Set(raw.evidenceIds).size !== raw.evidenceIds.length ||
      (raw.action === 'BUY' && raw.evidenceIds.length === 0)) {
    throw new Error('Invalid screener decision');
  }
  return { action: raw.action, rationale: raw.rationale,
    risks: raw.risks as string[], evidenceIds: raw.evidenceIds as string[] };
}

export class LlmScreenerAgent implements ScreenerAgent {
  private readonly provider: LlmProvider;
  private readonly modelVersion: string;
  private readonly clock: () => Date;
  private readonly lessons: readonly Lesson[];

  constructor(provider: LlmProvider, modelVersion: string,
    clock: () => Date, lessons: readonly Lesson[] = []) {
    if (!ID.test(modelVersion)) throw new Error('Invalid model version');
    this.provider = provider;
    this.modelVersion = modelVersion;
    this.clock = clock;
    this.lessons = immutableSnapshot(lessons);
  }

  async propose(candidate: TokenCandidate, intelligence: TokenIntelligence,
    signal?: AbortSignal): Promise<ScreenerProposal> {
    const stable = immutableSnapshot({ candidate, intelligence });
    candidate = stable.candidate;
    intelligence = stable.intelligence;
    const messages = buildScreenerMessages(candidate, intelligence, this.lessons);
    const output = parseDecision(await this.provider.completeJson(messages, SCREENER_SCHEMA, signal),
      intelligence.evidenceIds);
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid screener clock');
    return parseScreenerProposal({
      candidateId: candidate.id, snapshotId: intelligence.snapshotId,
      action: output.action, rationale: output.rationale,
      risks: output.risks, evidenceIds: output.evidenceIds,
      modelVersion: this.modelVersion, promptVersion: PROMPT_VERSION,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
  }
}
