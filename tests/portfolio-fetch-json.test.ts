import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLimiter } from "@/lib/portfolio/concurrency";
import { ProviderAuthError, VendorError } from "@/lib/portfolio/errors";
import {
  backoffDelay,
  fetchJSON,
  isRetryableStatus,
  parseRetryAfter,
} from "@/lib/portfolio/fetch-json";

const URL_ = "https://vendor.test/v1/thing?api-key=secret";
const schema = z.looseObject({ value: z.number() });

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function settle<T>(p: Promise<T>): Promise<T> {
  await flush();
  await vi.runAllTimersAsync();
  return p;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pure helpers", () => {
  it("classifies retryable statuses", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(425)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });

  it("computes full-jitter backoff capped at 4s", () => {
    const half = () => 0.5;
    expect(backoffDelay(0, half)).toBe(150);
    expect(backoffDelay(1, half)).toBe(300);
    expect(backoffDelay(2, half)).toBe(600);
    expect(backoffDelay(10, half)).toBe(2000);
    expect(backoffDelay(10, () => 1)).toBe(4000);
  });
});

describe("fetchJSON", () => {
  it("returns the parsed body on 200", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: 7, extra: true }));
    const result = await fetchJSON(URL_, { vendor: "birdeye", schema });
    expect(result.value).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries 5xx with backoff and succeeds on the third attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ value: 1 }));
    const result = await settle(fetchJSON(URL_, { vendor: "birdeye", schema }));
    expect(result.value).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("waits exactly Retry-After on 429", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(json({ value: 2 }));
    const p = fetchJSON(URL_, { vendor: "birdeye", schema });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await p).value).toBe(2);
  });

  it("throws immediately when Retry-After exceeds the remaining budget", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429, { "retry-after": "30" }));
    const p = fetchJSON(URL_, { vendor: "birdeye", schema, budgetMs: 5_000 });
    const err = await settle(p.catch((e) => e));
    expect(err).toBeInstanceOf(VendorError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry 404", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    const err = await settle(
      fetchJSON(URL_, { vendor: "helius", schema }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(404);
    expect(err.retryable).toBe(false);
    expect(err.path).toBe("/v1/thing");
    expect(err.message).not.toContain("secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 401 and 403 to ProviderAuthError without retry", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    const err = await settle(
      fetchJSON(URL_, { vendor: "helius", schema }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.vendor).toBe("helius");
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a shape mismatch once, not retryable", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: "nope" }));
    const err = await settle(
      fetchJSON(URL_, { vendor: "birdeye", schema }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect(err.kind).toBe("shape");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("value:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a non-JSON 200 body", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("<html>", { status: 200 }))
      .mockResolvedValueOnce(json({ value: 3 }));
    const result = await settle(fetchJSON(URL_, { vendor: "birdeye", schema }));
    expect(result.value).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network errors", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json({ value: 4 }));
    const result = await settle(fetchJSON(URL_, { vendor: "helius", schema }));
    expect(result.value).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the last error with retryAfterMs when attempts are exhausted", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "1" }));
    const err = await settle(
      fetchJSON(URL_, { vendor: "birdeye", schema }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry when the caller's signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const err = await settle(
      fetchJSON(URL_, {
        vendor: "birdeye",
        schema,
        signal: controller.signal,
      }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect(err.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds the gate only during an attempt, not during backoff", async () => {
    const gate = createLimiter(1);
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ value: 1 }))
      .mockResolvedValueOnce(json({ value: 2 }));
    const slow = fetchJSON(URL_, { vendor: "birdeye", schema, gate });
    const fast = fetchJSON(URL_, { vendor: "birdeye", schema, gate });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [a, b] = await settle(Promise.all([slow, fast]));
    expect([a.value, b.value].sort()).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("counts time spent waiting for the gate against the budget", async () => {
    const gate = createLimiter(1);
    let release!: () => void;
    const held = gate(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const p = fetchJSON(URL_, {
      vendor: "birdeye",
      schema,
      gate,
      budgetMs: 1_000,
    }).catch((e) => e);
    await flush();
    vi.advanceTimersByTime(1_500);
    release();
    const err = await settle(p);
    expect(err).toBeInstanceOf(VendorError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("waiting for a vendor slot");
    expect(fetchMock).not.toHaveBeenCalled();
    await held;
  });

  it("honours attempts", async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    const err = await settle(
      fetchJSON(URL_, { vendor: "birdeye", schema, attempts: 1 }).catch(
        (e) => e,
      ),
    );
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
