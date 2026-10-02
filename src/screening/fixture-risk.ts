import type { RiskPolicy } from '../application/ports.ts';
import type { TokenRiskFacts } from '../risk/token.ts';
import { assessTokenRisk } from '../risk/token.ts';
import { parseRiskPolicy } from '../risk/policy.ts';

// Phase 7 can exercise the real deterministic token gate with fixtures.
// This does not create a live provider or an execution capability.
export function fixtureRiskPolicy(facts: TokenRiskFacts | null, config: unknown,
  clock: () => Date): RiskPolicy {
  const policy = parseRiskPolicy(config);
  return { assess: (candidate, intelligence) =>
    assessTokenRisk(candidate, intelligence, facts, policy, clock()) };
}
