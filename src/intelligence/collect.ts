import type { TokenCandidate, TokenIntelligence } from '../core/models.ts';
import { normalizeIntelligence, parseObservation } from './normalize.ts';

export interface ObservationProvider {
  readonly id: string;
  observe(candidate: TokenCandidate, signal: AbortSignal): Promise<readonly unknown[]>;
}

// A failed provider contributes no facts. Its exception and raw response never enter a log.
export async function collectIntelligence(candidate: TokenCandidate,
  providers: readonly ObservationProvider[], now: Date, timeoutMs = 2_000): Promise<TokenIntelligence> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      providers.length > 8) throw new Error('Invalid provider budget');
  const batches = await Promise.all(providers.map(async (provider) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Provider timeout'));
        }, timeoutMs);
      });
      const result = await Promise.race([provider.observe(candidate, controller.signal), deadline]);
      if (!Array.isArray(result) || result.length > 20) return [];
      return result.flatMap((item) => {
        try {
          const parsed = parseObservation(item);
          return parsed.sourceId === provider.id ? [parsed] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  const valid: unknown[] = [];
  const seen = new Set<string>();
  for (const batch of batches) {
    for (const item of batch) {
      try {
        const parsed = parseObservation(item);
        if (seen.has(parsed.evidenceId)) return normalizeIntelligence(candidate, [], now);
        normalizeIntelligence(candidate, [parsed], now);
        seen.add(parsed.evidenceId);
        valid.push(item);
        if (valid.length > 20) return normalizeIntelligence(candidate, [], now);
      } catch {
        // Quarantine malformed provider data without reflecting it in output.
      }
    }
  }
  return normalizeIntelligence(candidate, valid, now);
}
