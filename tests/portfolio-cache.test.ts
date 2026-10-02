import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/lib/portfolio/cache";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and expires values", () => {
    const cache = new TtlCache<number>(10, 1000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    vi.setSystemTime(1_001_001);
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the oldest entry at capacity", () => {
    const cache = new TtlCache<number>(2, 1000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("honours a per-entry ttl and skips storage for ttl 0", () => {
    const cache = new TtlCache<number | null>(10, 10_000);
    cache.set("short", null, 100);
    cache.set("long", 5);
    cache.set("none", 7, 0);
    expect(cache.get("none")).toBeUndefined();
    vi.setSystemTime(1_000_101);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe(5);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    const cache = new TtlCache<number>(10, 1000);
    const gate = deferred<number>();
    const fn = vi.fn(() => gate.promise);
    const a = cache.getOrFetch("k", fn);
    const b = cache.getOrFetch("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(cache.get("k")).toBe(42);
    expect(await cache.getOrFetch("k", fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection and retries on the next call", async () => {
    const cache = new TtlCache<number>(10, 1000);
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(9);
    await expect(cache.getOrFetch("k", fn)).rejects.toThrow("boom");
    expect(cache.get("k")).toBeUndefined();
    expect(await cache.getOrFetch("k", fn)).toBe(9);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("turns a synchronous throw into a rejection and clears the slot", async () => {
    const cache = new TtlCache<number>(10, 1000);
    await expect(
      cache.getOrFetch("k", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(await cache.getOrFetch("k", async () => 1)).toBe(1);
  });

  it("caches null values and applies ttlFor", async () => {
    const cache = new TtlCache<number | null>(10, 10_000);
    const fn = vi.fn(async () => null);
    const ttlFor = (v: number | null) => (v === null ? 100 : undefined);
    expect(await cache.getOrFetch("k", fn, ttlFor)).toBeNull();
    expect(await cache.getOrFetch("k", fn, ttlFor)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_101);
    expect(await cache.getOrFetch("k", fn, ttlFor)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
