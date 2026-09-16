import { describe, expect, it } from "vitest";
import { coveredCostBasis } from "@/lib/portfolio/pnl";

describe("coveredCostBasis", () => {
  it("uses weighted-average cost when balance is within tracked buys", () => {
    const r = coveredCostBasis(60, 200, 100);
    expect(r.avgCostPerToken).toBeCloseTo(2);
    expect(r.coveredAmount).toBe(60);
    expect(r.costBasis).toBeCloseTo(120);
  });

  it("covers the full balance when buys equal holdings", () => {
    const r = coveredCostBasis(100, 200, 100);
    expect(r.coveredAmount).toBe(100);
    expect(r.costBasis).toBeCloseTo(200);
  });

  it("never dilutes cost across untracked acquisitions", () => {
    const r = coveredCostBasis(50, 700, 1);
    expect(r.avgCostPerToken).toBeCloseTo(700);
    expect(r.coveredAmount).toBe(1);
    expect(r.costBasis).toBeCloseTo(700);
  });

  it("caps coverage at the remaining household pool", () => {
    const first = coveredCostBasis(60, 200, 100, 100);
    expect(first.coveredAmount).toBe(60);
    expect(first.costBasis).toBeCloseTo(120);
    const second = coveredCostBasis(60, 200, 100, 100 - first.coveredAmount);
    expect(second.coveredAmount).toBe(40);
    expect(second.costBasis).toBeCloseTo(80);
    expect(coveredCostBasis(60, 200, 100, 0).coveredAmount).toBe(0);
  });

  it("returns zeros without tracked buys or spend", () => {
    expect(coveredCostBasis(10, 0, 5)).toEqual({
      coveredAmount: 0,
      avgCostPerToken: 0,
      costBasis: 0,
    });
    expect(coveredCostBasis(10, 100, 0)).toEqual({
      coveredAmount: 0,
      avgCostPerToken: 0,
      costBasis: 0,
    });
    expect(coveredCostBasis(0, 100, 5)).toEqual({
      coveredAmount: 0,
      avgCostPerToken: 0,
      costBasis: 0,
    });
  });
});
