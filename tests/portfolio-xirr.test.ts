import { describe, expect, it } from "vitest";
import { computeXIRR } from "@/lib/portfolio/xirr";

const YEAR = Math.round(365.25 * 86400);
const T0 = 1_600_000_000;

describe("computeXIRR", () => {
  it("recovers a simple 10% annual return", () => {
    const r = computeXIRR([
      { ts: T0, amount: -100 },
      { ts: T0 + YEAR, amount: 110 },
    ]);
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.1, 4);
  });

  it("handles multiple deposits", () => {
    const r = computeXIRR([
      { ts: T0, amount: -100 },
      { ts: T0 + YEAR / 2, amount: -100 },
      { ts: T0 + YEAR, amount: 220 },
    ]);
    expect(r).not.toBeNull();
    expect(r as number).toBeGreaterThan(0.09);
    expect(r as number).toBeLessThan(0.2);
  });

  it("returns a negative rate for a losing portfolio", () => {
    const r = computeXIRR([
      { ts: T0, amount: -100 },
      { ts: T0 + YEAR, amount: 50 },
    ]);
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(-0.5, 3);
  });

  it("returns null without both inflows and outflows", () => {
    expect(
      computeXIRR([
        { ts: T0, amount: -100 },
        { ts: T0 + YEAR, amount: -50 },
      ]),
    ).toBeNull();
    expect(computeXIRR([{ ts: T0, amount: -100 }])).toBeNull();
    expect(computeXIRR([])).toBeNull();
  });

  it("ignores non-finite entries", () => {
    const r = computeXIRR([
      { ts: T0, amount: -100 },
      { ts: Number.NaN, amount: 9999 },
      { ts: T0 + YEAR, amount: 110 },
    ]);
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.1, 4);
  });
});
