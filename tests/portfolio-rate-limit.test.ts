import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/portfolio/request";

describe("createRateLimiter", () => {
  it("allows up to capacity, then rejects", () => {
    const take = createRateLimiter(3, 60);
    const t0 = 1_000_000;
    expect(take(t0)).toBe(true);
    expect(take(t0)).toBe(true);
    expect(take(t0)).toBe(true);
    expect(take(t0)).toBe(false);
  });

  it("refills over time up to capacity", () => {
    const take = createRateLimiter(2, 60);
    const t0 = 1_000_000;
    expect(take(t0)).toBe(true);
    expect(take(t0)).toBe(true);
    expect(take(t0)).toBe(false);
    expect(take(t0 + 1_000)).toBe(true);
    expect(take(t0 + 1_100)).toBe(false);
    expect(take(t0 + 120_000)).toBe(true);
    expect(take(t0 + 120_000)).toBe(true);
    expect(take(t0 + 120_000)).toBe(false);
  });
});
