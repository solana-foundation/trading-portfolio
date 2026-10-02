import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHistoricalPrice,
  getHistoricalPrices,
  getNetWorthHistory,
  getPriceSeries,
  getTokenMeta,
  getTokenMetas,
} from "@/lib/portfolio/birdeye";
import { ProviderAuthError, VendorError } from "@/lib/portfolio/errors";

const DAY = 86_400;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function settle<T>(p: Promise<T>): Promise<T> {
  await flush();
  await vi.runAllTimersAsync();
  return p;
}

let seq = 0;
function mint(): string {
  seq += 1;
  return `Mint${seq.toString().padStart(40, "0")}`;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("BIRDEYE_API_KEY", "test-key");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("fails loud with kind config when the key is missing", async () => {
    vi.stubEnv("BIRDEYE_API_KEY", "");
    const err = await getHistoricalPrice(mint(), DAY * 100).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect(err.kind).toBe("config");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getHistoricalPrice", () => {
  it("returns and caches a price", async () => {
    const m = mint();
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { value: 1.5 } }),
    );
    expect(await getHistoricalPrice(m, DAY * 10 + 5)).toBe(1.5);
    expect(await getHistoricalPrice(m, DAY * 10 + 999)).toBe(1.5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers["X-API-KEY"]).toBe("test-key");
  });

  it("caches vendor-asserted absence as null", async () => {
    const m = mint();
    fetchMock.mockResolvedValueOnce(json({ success: true, data: {} }));
    expect(await getHistoricalPrice(m, DAY * 10)).toBeNull();
    expect(await getHistoricalPrice(m, DAY * 10)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats success:false as unpriced for this call only, never cached", async () => {
    const m = mint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(json({ success: false, message: "bad address" }))
      .mockResolvedValueOnce(json({ success: true, data: { value: 4 } }));
    expect(await getHistoricalPrice(m, DAY * 10)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("bad address");
    expect(await getHistoricalPrice(m, DAY * 10)).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a body without the success flag as unusable for this call only", async () => {
    const m = mint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ data: {} }))
      .mockResolvedValueOnce(json({ success: true, data: { value: 6 } }));
    expect(await getHistoricalPrice(m, DAY * 10)).toBeNull();
    expect(await getHistoricalPrice(m, DAY * 10)).toBeNull();
    expect(await getHistoricalPrice(m, DAY * 10)).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("without a success flag");
  });

  it("fails loud when a successful body carries a price of the wrong type", async () => {
    const m = mint();
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { value: "12.5" } }),
    );
    const err = await getHistoricalPrice(m, DAY * 10).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect(err.kind).toBe("shape");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws after retries on 5xx and does not cache the failure", async () => {
    const m = mint();
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ success: true, data: { value: 2 } }));
    const err = await settle(getHistoricalPrice(m, DAY * 10).catch((e) => e));
    expect(err).toBeInstanceOf(VendorError);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await settle(getHistoricalPrice(m, DAY * 10))).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns null for a non-positive timestamp without fetching", async () => {
    expect(await getHistoricalPrice(mint(), 0)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getHistoricalPrices", () => {
  it("dedupes repeated mint:day keys and bounds concurrency", async () => {
    const m = mint();
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json({ success: true, data: { value: 3 } });
    });
    const queries = Array.from({ length: 20 }, (_, i) => ({
      mint: m,
      ts: DAY * (100 + i) + (i % 2),
    }));
    queries.push({ mint: m, ts: DAY * 100 + 7 });
    const out = await settle(getHistoricalPrices(queries));
    expect(out.size).toBe(20);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(out.get(`${m}:${DAY * 100}`)).toBe(3);
    expect(peak).toBe(8);
  });

  it("skips zero timestamps", async () => {
    const out = await getHistoricalPrices([{ mint: mint(), ts: 0 }]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getPriceSeries", () => {
  it("rejects when a later chunk fails instead of returning a partial map", async () => {
    const m = mint();
    fetchMock
      .mockResolvedValueOnce(
        json({ success: true, data: { items: [{ unixTime: DAY, value: 1 }] } }),
      )
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500));
    const err = await settle(getPriceSeries(m, 0, DAY * 1000).catch((e) => e));
    expect(err).toBeInstanceOf(VendorError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("merges chunks keyed by floored day", async () => {
    const m = mint();
    fetchMock
      .mockResolvedValueOnce(
        json({
          success: true,
          data: { items: [{ unixTime: DAY + 5, value: 1 }, { value: 0 }] },
        }),
      )
      .mockResolvedValueOnce(
        json({
          success: true,
          data: { items: [{ unixTime: DAY * 900, value: 2 }] },
        }),
      );
    const out = await getPriceSeries(m, 0, DAY * 1000);
    expect(Array.from(out.entries())).toEqual([
      [DAY, 1],
      [DAY * 900, 2],
    ]);
  });
});

describe("getNetWorthHistory", () => {
  it("propagates vendor failures", async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    const err = await settle(getNetWorthHistory(mint()).catch((e) => e));
    expect(err).toBeInstanceOf(VendorError);
    expect(err.status).toBe(503);
  });

  it("maps history rows to past days only", async () => {
    vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));
    fetchMock.mockResolvedValueOnce(
      json({
        data: {
          history: [
            { timestamp: "2026-01-09T00:00:00Z", net_worth: 10 },
            { timestamp: "2026-01-10T00:00:00Z", net_worth: 11 },
            { timestamp: "bad", net_worth: 12 },
          ],
        },
      }),
    );
    const out = await getNetWorthHistory(mint());
    expect(out.size).toBe(1);
    expect(out.get(Math.floor(Date.parse("2026-01-09T00:00:00Z") / 1000))).toBe(
      10,
    );
  });
});

describe("getTokenMeta", () => {
  it("degrades to null on exhausted transport failure, uncached, with a warning", async () => {
    const m = mint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(
        json({ success: true, data: { symbol: "ABC", logo_uri: "x" } }),
      );
    expect(await settle(getTokenMeta(m))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("status=500");
    expect(await settle(getTokenMeta(m))).toEqual({ symbol: "ABC", icon: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rethrows auth failures", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(getTokenMeta(mint())).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  it("caches a vendor-asserted miss as null", async () => {
    const m = mint();
    fetchMock.mockResolvedValueOnce(json({ success: true, data: {} }));
    expect(await getTokenMeta(m)).toBeNull();
    expect(await getTokenMeta(m)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a refusal or a body without the success flag", async () => {
    const m = mint();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(json({ success: false }))
      .mockResolvedValueOnce(json({ data: { symbol: "X" } }))
      .mockResolvedValueOnce(json({ success: true, data: { symbol: "X" } }));
    expect(await getTokenMeta(m)).toBeNull();
    expect(await getTokenMeta(m)).toBeNull();
    expect(await getTokenMeta(m)).toEqual({ symbol: "X" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("getTokenMetas", () => {
  it("returns only resolved metadata, deduped", async () => {
    const a = mint();
    const b = mint();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(a)) {
        return json({ success: true, data: { symbol: "AAA" } });
      }
      return json({ success: false });
    });
    const out = await getTokenMetas([a, b, a]);
    expect(out.size).toBe(1);
    expect(out.get(a)).toEqual({ symbol: "AAA" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
