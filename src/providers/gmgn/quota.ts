// Testable planning boundary only. No GMGN URL, credential, or HTTP client exists here.
// Live use needs a durable, atomic ledger shared by every process using the same key.
export interface WeightedQuotaLedger {
  reserve(weight: number, nowMs: number): Promise<boolean>;
  cooldown(untilMs: number): Promise<void>;
}

export class InMemoryWeightedQuota implements WeightedQuotaLedger {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly dailyLimit: number;
  private balance: number;
  private lastMs: number;
  private day: number;
  private usedToday = 0;
  private pauseUntil = 0;

  constructor(capacity: number, refillPerSecond: number, dailyLimit: number, startMs = 0) {
    if (![capacity, refillPerSecond, dailyLimit].every((value) =>
      Number.isFinite(value) && value > 0) || !Number.isFinite(startMs)) {
      throw new Error('Invalid quota');
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.dailyLimit = dailyLimit;
    this.balance = capacity;
    this.lastMs = startMs;
    this.day = Math.floor(startMs / 86_400_000);
  }

  async reserve(weight: number, nowMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > this.capacity ||
        !Number.isFinite(nowMs) || nowMs < this.lastMs) throw new Error('Invalid quota request');
    const day = Math.floor(nowMs / 86_400_000);
    if (day !== this.day) {
      this.day = day;
      this.usedToday = 0;
    }
    this.balance = Math.min(this.capacity,
      this.balance + (nowMs - this.lastMs) * this.refillPerSecond / 1000);
    this.lastMs = nowMs;
    if (nowMs < this.pauseUntil || this.usedToday + weight > this.dailyLimit ||
        this.balance < weight) return false;
    this.balance -= weight;
    this.usedToday += weight;
    return true;
  }

  async cooldown(untilMs: number): Promise<void> {
    if (!Number.isFinite(untilMs)) throw new Error('Invalid cooldown');
    this.pauseUntil = Math.max(this.pauseUntil, untilMs);
  }
}

export class RateLimited extends Error {
  readonly resetAtMs: number;
  constructor(resetAtMs: number) {
    super('Provider rate limited');
    this.resetAtMs = resetAtMs;
  }
}

export class GmgnQueryGate {
  private readonly ledger: WeightedQuotaLedger;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<unknown | null>>();

  constructor(ledger: WeightedQuotaLedger, clock: () => number, timeoutMs = 2_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error('Invalid timeout');
    }
    this.ledger = ledger;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  async query<T>(key: string, weight: number, ttlMs: number,
    fetcher: (signal: AbortSignal) => Promise<unknown>,
    validate: (value: unknown) => T): Promise<T | null> {
    // Key must identify route, mint, and response schema; reuse one validator per key.
    if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(key) || !Number.isSafeInteger(weight) ||
        weight < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
      throw new Error('Invalid query');
    }
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.clock()) return cached.value as T;
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T | null>;
    const task = this.load(key, weight, ttlMs, fetcher, validate);
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async load<T>(key: string, weight: number, ttlMs: number,
    fetcher: (signal: AbortSignal) => Promise<unknown>,
    validate: (value: unknown) => T): Promise<T | null> {
    const now = this.clock();
    try {
      if (!await this.ledger.reserve(weight, now)) return null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Provider timeout'));
          }, this.timeoutMs);
        });
        const raw = await Promise.race([fetcher(controller.signal), deadline]);
        const value = validate(raw);
        this.cache.set(key, { value, expiresAt: this.clock() + ttlMs });
        return value;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof RateLimited && Number.isFinite(error.resetAtMs)) {
        await this.ledger.cooldown(error.resetAtMs);
      }
      return null;
    }
  }
}
