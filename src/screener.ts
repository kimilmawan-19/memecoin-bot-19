import type { GateResult, TradingDecision } from './domain.ts';

// No model, prompt, or trade strategy is configured in this phase. The
// screener has no access to execution and can only emit a SKIP proposal.
export function screen(gate: GateResult): TradingDecision {
  if (gate.status !== 'PASS') {
    return { action: 'SKIP', reason: 'RISK_GATE_NOT_PASSED' };
  }
  return { action: 'SKIP', reason: 'STRATEGY_AND_EXECUTION_DISABLED' };
}
