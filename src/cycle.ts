import type { CandidateSnapshot, DecisionRecord } from './domain.ts';
import { assessRisk } from './risk.ts';
import { screen } from './screener.ts';

export function runCycle(candidates: readonly CandidateSnapshot[], now: Date): readonly DecisionRecord[] {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid cycle time');
  return candidates.map((candidate) => {
    const gate = assessRisk(candidate, now);
    return {
      schemaVersion: 1,
      cycleAt: now.toISOString(),
      mint: candidate.mint,
      source: candidate.source,
      gate,
      decision: screen(gate)
    };
  });
}
