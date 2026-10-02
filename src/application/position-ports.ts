import type { OpenPosition, PositionProposal } from '../core/models.ts';
import type { ExitSignal, PositionObservation } from '../positions/monitor.ts';

// Agent and journal have no execution capability.
export interface ManagerAgent {
  propose(position: OpenPosition, observation: PositionObservation,
    signal?: AbortSignal): Promise<PositionProposal>;
}

export interface PositionJournal {
  append(proposal: PositionProposal, signal: ExitSignal): Promise<void>;
}
