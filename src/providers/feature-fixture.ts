import { readFile, stat } from 'node:fs/promises';
import type { TokenCandidate } from '../core/models.ts';
import { parseFeatureFrame, type FeatureFrame } from '../intelligence/feature-frame.ts';
import { deriveFeatureObservations } from '../intelligence/features.ts';
import type { ObservationProvider } from '../intelligence/collect.ts';
import type { Observation } from '../intelligence/normalize.ts';

const MAX_BYTES = 256 * 1024;

export class FixtureFeatureProvider implements ObservationProvider {
  readonly id = 'feature-fixture';
  private readonly frames: readonly FeatureFrame[];

  constructor(raw: unknown) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid feature fixture');
    }
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || input.version !== 1 ||
        !Array.isArray(input.frames) || input.frames.length > 4) {
      throw new Error('Invalid feature fixture');
    }
    const frames = input.frames.map(parseFeatureFrame);
    if (frames.some((frame) => frame.sourceId !== this.id) ||
        new Set(frames.map((frame) => frame.evidenceId)).size !== frames.length) {
      throw new Error('Invalid feature fixture');
    }
    this.frames = Object.freeze(frames);
  }

  async observe(candidate: TokenCandidate): Promise<readonly Observation[]> {
    return this.frames.filter((frame) => frame.candidateId === candidate.id &&
      frame.mint === candidate.mint).flatMap(deriveFeatureObservations);
  }
}

export async function loadFixtureFeatureProvider(path: string): Promise<FixtureFeatureProvider> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid feature fixture');
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('Invalid feature fixture');
  try {
    return new FixtureFeatureProvider(JSON.parse(raw));
  } catch {
    throw new Error('Invalid feature fixture');
  }
}
