/** In-memory sliding-window limiter for failed logins (per IP and per email). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0 if allowed now. */
  retryAfter(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length < this.max) return 0;
    return Math.ceil((this.windowMs - (now - list[0]!)) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
