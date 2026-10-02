import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthError, VendorError } from "@/lib/portfolio/errors";
import { fetchTransactions, heliusRpcUrl } from "@/lib/portfolio/tx-provider";

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
function wallet(): string {
  seq += 1;
  return `Wallet${seq.toString().padStart(38, "0")}`;
}

function tx(signature: string, timestamp: number) {
  return { signature, timestamp, type: "TRANSFER" };
}

function fullPage(prefix: string, timestamp: number) {
  return Array.from({ length: 100 }, (_, i) =>
    tx(`${prefix}${i}`, timestamp - i),
  );
}

const emptyAccounts = { jsonrpc: "2.0", id: 1, result: { value: [] } };

const fetchMock = vi.fn<typeof fetch>();

function routes(
  handlers: Array<
    [match: (url: string, body: string) => boolean, reply: () => Response]
  >,
) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    for (const [match, reply] of handlers) {
      if (match(url, body)) return reply();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const isHelius = (url: string) => url.startsWith("https://api.helius.xyz/");
const isTriton = (url: string) => url.startsWith("https://triton.test/");
const isRpc = (url: string) =>
  url.startsWith("https://mainnet.helius-rpc.com/");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HELIUS_API_KEY", "helius-key");
  vi.stubEnv("TRITON_API_URL", "https://triton.test/");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("heliusRpcUrl", () => {
  it("throws kind config when the key is missing", () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    expect(() => heliusRpcUrl()).toThrow(VendorError);
    try {
      heliusRpcUrl();
    } catch (e) {
      expect((e as VendorError).kind).toBe("config");
    }
  });
});

describe("fetchTransactions", () => {
  it("maps a 401 on the first page to ProviderAuthError", async () => {
    vi.stubEnv("TRITON_API_URL", "");
    routes([[isHelius, () => json({}, 401)]]);
    const err = await settle(fetchTransactions(wallet()).catch((e) => e));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.vendor).toBe("helius");
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Triton after Helius exhausts its retries", async () => {
    const w = wallet();
    routes([
      [isHelius, () => json({}, 500)],
      [isTriton, () => json([tx("t1", 10)])],
      [isRpc, () => json(emptyAccounts)],
    ]);
    const result = await settle(fetchTransactions(w));
    expect(result.txs.map((t) => t.signature)).toEqual(["t1"]);
    expect(result.truncated).toBe(false);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter(isHelius)).toHaveLength(3);
    expect(urls.filter(isTriton)).toHaveLength(1);
    expect(urls.filter(isRpc)).toHaveLength(2);
    expect(urls.some((u) => u.includes(w))).toBe(true);
  });

  it("pages with a before cursor and stops on a short page", async () => {
    const w = wallet();
    let page = 0;
    routes([
      [
        isHelius,
        () => {
          page += 1;
          return page === 1 ? json(fullPage("a", 1000)) : json([tx("b", 1)]);
        },
      ],
      [isRpc, () => json(emptyAccounts)],
    ]);
    const result = await fetchTransactions(w);
    expect(result.txs).toHaveLength(101);
    expect(result.truncated).toBe(false);
    const heliusUrls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter(isHelius);
    expect(heliusUrls).toHaveLength(2);
    expect(heliusUrls[0]).not.toContain("before=");
    expect(heliusUrls[1]).toContain("before=a99");
  });

  it("reports truncation when a full page has no usable final signature", async () => {
    const page = fullPage("n", 900);
    page[page.length - 1] = { timestamp: 1, type: "TRANSFER" } as never;
    routes([
      [isHelius, () => json(page)],
      [isRpc, () => json(emptyAccounts)],
    ]);
    const result = await fetchTransactions(wallet());
    expect(result.txs).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("reports truncation when the page cap is reached", async () => {
    routes([
      [isHelius, () => json(fullPage("c", 500))],
      [isRpc, () => json(emptyAccounts)],
    ]);
    const result = await fetchTransactions(wallet(), 1);
    expect(result.txs).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("treats a non-array, non-error body as a shape failure", async () => {
    vi.stubEnv("TRITON_API_URL", "");
    routes([[isHelius, () => json({ unexpected: true })]]);
    const err = await settle(fetchTransactions(wallet()).catch((e) => e));
    expect(err).toBeInstanceOf(VendorError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.kind).toBe("shape");
    expect(err.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails loud on a malformed token-account envelope instead of reporting complete history", async () => {
    for (const body of [
      {},
      { result: null },
      { result: {} },
      { result: { value: null } },
    ]) {
      const w = wallet();
      routes([
        [isHelius, () => json([tx("x", 1)])],
        [isRpc, () => json(body)],
      ]);
      const err = await fetchTransactions(w).catch((e) => e);
      expect(err).toBeInstanceOf(VendorError);
      expect(err.kind).toBe("shape");
      expect(await fetchTransactions(w).catch((e) => e)).toBeInstanceOf(
        VendorError,
      );
    }
  });

  it("rejects a page whose nested swap or transfer containers are malformed", async () => {
    const malformed = [
      {
        signature: "a",
        events: { swap: { tokenInputs: { not: "an array" } } },
      },
      { signature: "b", tokenTransfers: "nope" },
      { signature: "c", timestamp: "1700000000" },
    ];
    for (const txBody of malformed) {
      vi.stubEnv("TRITON_API_URL", "");
      routes([[isHelius, () => json([txBody])]]);
      const err = await fetchTransactions(wallet()).catch((e) => e);
      expect(err).toBeInstanceOf(VendorError);
      expect(err.kind).toBe("shape");
    }
  });

  it("maps a JSON-RPC auth error code to ProviderAuthError", async () => {
    routes([
      [isHelius, () => json([tx("x", 1)])],
      [
        isRpc,
        () => json({ error: { code: -32401, message: "invalid api key" } }),
      ],
    ]);
    const err = await settle(fetchTransactions(wallet()).catch((e) => e));
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.path).toBe("getTokenAccountsByOwner");
  });

  it("throws ProviderAuthError when no provider is configured", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    vi.stubEnv("TRITON_API_URL", "");
    const err = await fetchTransactions(wallet()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toContain("No transaction provider configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges token-account history, dedupes by signature, sorts newest first", async () => {
    const w = wallet();
    routes([
      [
        (url) => isHelius(url) && url.includes(`/${w}/`),
        () => json([tx("shared", 5), tx("owner", 3)]),
      ],
      [
        (url) => isHelius(url) && url.includes("/acct1/"),
        () => json([tx("shared", 5), tx("acct", 9)]),
      ],
      [
        isRpc,
        () =>
          json({
            result: { value: [{ pubkey: "acct1" }] },
          }),
      ],
    ]);
    const result = await fetchTransactions(w);
    expect(result.txs.map((t) => t.signature)).toEqual([
      "acct",
      "shared",
      "owner",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("marks history truncated when token accounts cannot be enumerated", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    routes([[isTriton, () => json([tx("t", 1)])]]);
    const result = await fetchTransactions(wallet());
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one crawl between concurrent callers", async () => {
    const w = wallet();
    routes([
      [isHelius, () => json([tx("one", 1)])],
      [isRpc, () => json(emptyAccounts)],
    ]);
    const [a, b] = await Promise.all([
      fetchTransactions(w),
      fetchTransactions(w),
    ]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
