import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, requestBudget } from "@/lib/portfolio/deadline";
import { mapError } from "@/lib/portfolio/errors";

describe("requestBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes results through inside the budget", async () => {
    const within = requestBudget(1_000, "summary");
    expect(await within(Promise.resolve(7))).toBe(7);
  });

  it("rejects with DeadlineError when the budget elapses, sharing one clock across awaits", async () => {
    const within = requestBudget(1_000, "summary");
    const first = within(
      new Promise<number>((r) => setTimeout(() => r(1), 600)),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(await first).toBe(1);
    const second = within(
      new Promise<number>((r) => setTimeout(() => r(2), 600)),
    );
    const expectation = expect(second).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(400);
    await expectation;
  });

  it("rejects immediately once the budget is already spent", async () => {
    const within = requestBudget(100, "pnl");
    await vi.advanceTimersByTimeAsync(150);
    await expect(within(new Promise(() => {}))).rejects.toBeInstanceOf(
      DeadlineError,
    );
  });
});

describe("mapError for DeadlineError", () => {
  it("maps to a 502 with the time-budget message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mapError(new DeadlineError("summary", 1), "fallback")).toEqual({
      status: 502,
      error: "Request exceeded its time budget; retry shortly.",
    });
    vi.restoreAllMocks();
  });
});
