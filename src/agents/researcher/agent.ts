import type { LlmProvider } from '../../llm/provider.ts';
import { parseResearchDataset, parseResearchReport,
  type ResearchDataset, type ResearchReport } from '../../learning/research.ts';
import { buildResearcherMessages, RESEARCHER_PROMPT_VERSION,
  RESEARCHER_SCHEMA } from './prompt.ts';

const ID = /^[a-zA-Z0-9._-]{1,64}$/;

export class LlmResearcherAgent {
  private readonly provider: LlmProvider;
  private readonly modelVersion: string;
  private readonly clock: () => Date;

  constructor(provider: LlmProvider, modelVersion: string, clock: () => Date) {
    if (!ID.test(modelVersion)) throw new Error('Invalid researcher model');
    this.provider = provider;
    this.modelVersion = modelVersion;
    this.clock = clock;
  }

  async propose(id: string, input: ResearchDataset,
    signal?: AbortSignal): Promise<ResearchReport> {
    if (!ID.test(id)) throw new Error('Invalid research ID');
    const dataset = parseResearchDataset(input);
    const output = await this.provider.completeJson(
      buildResearcherMessages(dataset), RESEARCHER_SCHEMA, signal);
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw new Error('Invalid researcher output');
    }
    const raw = output as Record<string, unknown>;
    const keys = ['rule', 'supportingTradeIds', 'counterexampleTradeIds', 'thresholdReview'];
    if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key))) {
      throw new Error('Invalid researcher output');
    }
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid researcher clock');
    return parseResearchReport({ id, dataset,
      lesson: { id, version: 1, status: 'PROPOSED', rule: raw.rule,
        supportingTradeIds: raw.supportingTradeIds,
        counterexampleTradeIds: raw.counterexampleTradeIds,
        proposedAt: now.toISOString() },
      thresholdReview: raw.thresholdReview,
      modelVersion: this.modelVersion, promptVersion: RESEARCHER_PROMPT_VERSION });
  }
}
