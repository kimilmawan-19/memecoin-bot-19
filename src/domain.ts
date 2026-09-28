export type RiskFacts = Readonly<{
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  liquidityUsd: number | null;
}>;

export type CandidateSnapshot = Readonly<{
  mint: string;
  observedAt: string;
  source: 'fixture';
  risk: RiskFacts;
}>;

export type GateStatus = 'PASS' | 'REJECT' | 'UNKNOWN';
export type GateResult = Readonly<{
  status: GateStatus;
  reasons: readonly string[];
}>;

export type TradingDecision = Readonly<{
  action: 'SKIP';
  reason: string;
}>;

export type DecisionRecord = Readonly<{
  schemaVersion: 1;
  cycleAt: string;
  mint: string;
  source: 'fixture';
  gate: GateResult;
  decision: TradingDecision;
}>;

// A future agent can propose an action, but this core currently has no
// execution capability. No TradingAdapter or signer is constructed here.
