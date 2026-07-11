function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMRateLimiter {
  private tokens: number;
  private lastRefillAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillWindowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;

    const refillRate = this.capacity / this.refillWindowMs;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * refillRate);
    this.lastRefillAt = now;
  }

  private msUntilNextToken(): number {
    if (this.tokens >= 1) return 0;
    const refillRate = this.capacity / this.refillWindowMs;
    const missing = 1 - this.tokens;
    return Math.ceil(missing / refillRate);
  }

  async acquire(provider: string): Promise<void> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });

    await previous;
    try {
      while (true) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }

        const waitMs = this.msUntilNextToken();
        console.log(`[throttle] delaying ${provider} call for ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    } finally {
      release();
    }
  }
}

export const sharedLLMRateLimiter = new LLMRateLimiter(6, 60_000);
