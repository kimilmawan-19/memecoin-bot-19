import type { OpenPosition, PositionProposal } from '../core/models.ts';
import { parsePositionProposal } from '../core/position-proposal.ts';
import { immutableSnapshot } from '../core/snapshot.ts';
import { assessExit, parseExitPolicy, type ExitPolicy, type ExitSignal,
  type PositionObservation } from '../positions/monitor.ts';
import type { ManagerAgent, PositionJournal } from './position-ports.ts';

export type PositionReview = Readonly<{
  signal: ExitSignal;
  proposal: PositionProposal;
}>;

function deterministic(position: OpenPosition, observation: PositionObservation,
  signal: ExitSignal, now: Date, reason: string): PositionProposal {
  return parsePositionProposal({
    positionId: position.id, positionVersion: position.version,
    snapshotId: observation.snapshotId,
    action: signal.status === 'EXIT' ? 'EXIT' : 'HOLD', reduceBps: null,
    rationale: reason, evidenceIds: signal.status === 'EXIT' ? observation.evidenceIds : [],
    modelVersion: 'deterministic-1', promptVersion: 'none',
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString()
  });
}

// Deterministic exits run before the LLM and are rechecked after it returns.
// No execution adapter or position mutation is available to this service.
export async function reviewPosition(position: OpenPosition,
  observation: PositionObservation, exitPolicy: ExitPolicy,
  agent: ManagerAgent, journal: PositionJournal, clock: () => Date,
  agentTimeoutMs = 10_000): Promise<PositionReview> {
  const stable = immutableSnapshot({ position, observation });
  position = stable.position;
  observation = stable.observation;
  const policy = parseExitPolicy(exitPolicy);
  const start = clock();
  if (!Number.isFinite(start.getTime()) ||
      !Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs < 1 || agentTimeoutMs > 30_000) {
    throw new Error('Invalid position review configuration');
  }
  let now = start;
  let signal = assessExit(position, observation, policy, now);
  let proposal: PositionProposal;
  if (signal.status !== 'NONE') {
    proposal = deterministic(position, observation, signal, now,
      signal.status === 'EXIT' ? signal.reasons.join(',') : 'MONITOR_UNKNOWN');
  } else {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('Manager timeout'));
        }, agentTimeoutMs);
      });
      const result = parsePositionProposal(await Promise.race([
        agent.propose(position, observation, controller.signal), timeout
      ]));
      now = clock();
      if (!Number.isFinite(now.getTime()) || now.getTime() < start.getTime()) {
        throw new Error('Invalid review clock');
      }
      signal = assessExit(position, observation, policy, now);
      if (result.positionId !== position.id || result.positionVersion !== position.version ||
          result.snapshotId !== observation.snapshotId ||
          result.evidenceIds.some((id) => !observation.evidenceIds.includes(id)) ||
          Date.parse(result.createdAt) > now.getTime() ||
          Date.parse(result.expiresAt) <= now.getTime()) {
        throw new Error('Mismatched position proposal');
      }
      proposal = signal.status === 'EXIT'
        ? deterministic(position, observation, signal, now, signal.reasons.join(','))
        : signal.status === 'UNKNOWN'
          ? deterministic(position, observation, signal, now, 'MONITOR_UNKNOWN')
          : result;
    } catch {
      const failedAt = clock();
      now = Number.isFinite(failedAt.getTime()) && failedAt.getTime() >= start.getTime()
        ? failedAt : start;
      signal = assessExit(position, observation, policy, now);
      proposal = deterministic(position, observation, signal, now,
        signal.status === 'EXIT' ? signal.reasons.join(',') :
          timedOut ? 'AGENT_TIMEOUT' : 'INVALID_AGENT_PROPOSAL');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  await journal.append(proposal, signal);
  return Object.freeze({ signal, proposal });
}
