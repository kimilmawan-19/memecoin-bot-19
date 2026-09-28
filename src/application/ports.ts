import type {
  ScreenerProposal, TokenCandidate, TokenIntelligence, TokenRiskAssessment
} from '../core/models.ts';

export interface CandidateSource {
  discover(): Promise<readonly TokenCandidate[]>;
}

export interface IntelligenceSource {
  observe(candidate: TokenCandidate): Promise<TokenIntelligence>;
}

export interface RiskPolicy {
  assess(candidate: TokenCandidate, intelligence: TokenIntelligence): TokenRiskAssessment;
}

// Agents may read facts and return proposals. They cannot call execution.
export interface ScreenerAgent {
  propose(candidate: TokenCandidate, intelligence: TokenIntelligence): Promise<ScreenerProposal>;
}

export interface DecisionJournal {
  append(proposal: ScreenerProposal, risk: TokenRiskAssessment): Promise<void>;
}
