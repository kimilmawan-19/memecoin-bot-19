export type ExecutionState = 'PROPOSED' | 'AUTHORIZED' | 'SUBMITTED' |
  'CONFIRMED' | 'FAILED' | 'UNKNOWN';
export type TransitionProof = 'guard' | 'submit' | 'reconciliation';

// A timeout is UNKNOWN, not FAILED. Only reconciliation can resolve it.
export function canTransition(
  current: ExecutionState,
  next: ExecutionState,
  proof: TransitionProof
): boolean {
  if (current === 'PROPOSED') return next === 'AUTHORIZED' && proof === 'guard';
  if (current === 'AUTHORIZED') return next === 'SUBMITTED' && proof === 'submit';
  if (current === 'SUBMITTED') {
    return proof === 'reconciliation' &&
      (next === 'CONFIRMED' || next === 'FAILED' || next === 'UNKNOWN');
  }
  if (current === 'UNKNOWN') {
    return proof === 'reconciliation' && (next === 'CONFIRMED' || next === 'FAILED');
  }
  return false;
}
