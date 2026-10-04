export class TtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  private pending = new Map<string, Promise<V>>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (ttlMs <= 0) return;
    if (!this.map.has(key) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  getOrFetch(
    key: string,
    fn: () => Promise<V>,
    ttlFor?: (value: V) => number | undefined,
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    let started: Promise<V>;
    try {
      started = fn();
    } catch (e) {
      started = Promise.reject(e);
    }
    const p = started
      .then((value) => {
        this.set(key, value, ttlFor?.(value));
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
}
