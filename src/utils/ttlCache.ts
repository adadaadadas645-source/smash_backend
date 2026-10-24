/**
 * A small in-memory cache with a time limit and a size limit (the oldest entry goes first), and
 * single-flight loading: while one caller loads a key, the others wait for that same load
 * instead of each going to Firestore. This is what keeps a burst of players opening the
 * leaderboard at once down to one query.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private readonly loading = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  async getOrLoad(key: string, load: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const p = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }
}
