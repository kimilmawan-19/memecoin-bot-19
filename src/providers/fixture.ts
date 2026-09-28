import { readFile, stat } from 'node:fs/promises';
import type { TokenCandidate } from '../core/models.ts';
import type { ObservationProvider } from '../intelligence/collect.ts';
import { parseObservation, type Observation } from '../intelligence/normalize.ts';

const MAX_BYTES = 256 * 1024;

export class FixtureObservationProvider implements ObservationProvider {
  readonly id = 'fixture';
  private readonly observations: readonly Observation[];

  constructor(raw: unknown) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid fixture');
    }
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || input.version !== 1 ||
        !Array.isArray(input.observations) || input.observations.length > 20) {
      throw new Error('Invalid fixture');
    }
    this.observations = Object.freeze(input.observations.map(parseObservation));
  }

  async observe(candidate: TokenCandidate): Promise<readonly Observation[]> {
    return this.observations.filter((item) => item.candidateId === candidate.id);
  }
}

export async function loadFixtureProvider(path: string): Promise<FixtureObservationProvider> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid fixture');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Invalid fixture');
  try {
    return new FixtureObservationProvider(JSON.parse(text));
  } catch {
    throw new Error('Invalid fixture');
  }
}
