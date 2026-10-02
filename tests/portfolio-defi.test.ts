import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefiPositions } from "@/lib/portfolio/defi";
import { ProviderAuthError, VendorError } from "@/lib/portfolio/errors";

const MARGINFI = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const NFT_A = "NftA11111111111111111111111111111111111111";
const NFT_B = "NftB11111111111111111111111111111111111111";

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
  return `DefiWallet${seq.toString().padStart(34, "0")}`;
}

type RpcCall = { method: string; params: unknown[] };

function parseRpc(init: RequestInit | undefined): RpcCall | null {
  if (typeof init?.body !== "string") return null;
  const body = JSON.parse(init.body) as RpcCall;
  return body;
}

function programOf(call: RpcCall): string {
  return String(call.params[0]);
}

function memcmpBytes(call: RpcCall): string {
  const opts = call.params[1] as {
    filters?: Array<{ memcmp?: { bytes?: string } }>;
  };
  return opts.filters?.[0]?.memcmp?.bytes ?? "";
}

const sliced = (pubkey: string) => ({
  pubkey,
  account: { data: ["", "base64"] },
});

const nftAccount = (mint: string) => ({
  account: {
    data: {
      parsed: { info: { mint, tokenAmount: { amount: "1", decimals: 0 } } },
    },
  },
});

type Handler = (url: string, rpc: RpcCall | null) => Response | undefined;

const fetchMock = vi.fn<typeof fetch>();

function install(custom: Handler) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const rpc = parseRpc(init);
    const res = custom(url, rpc);
    if (res) return res;
    if (url.startsWith("https://api.helius.xyz/")) return json([]);
    if (rpc?.method === "getProgramAccounts") return json({ result: [] });
    if (rpc?.method === "getTokenAccountsByOwner") {
      return json({ result: { value: [] } });
    }
    if (rpc?.method === "getMultipleAccounts") {
      return json({ result: { value: [] } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HELIUS_API_KEY", "helius-key");
  vi.stubEnv("BIRDEYE_API_KEY", "birdeye-key");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getDefiPositions", () => {
  it("returns an empty, complete result for a wallet with nothing", async () => {
    install(() => undefined);
    const result = await getDefiPositions([wallet()]);
    expect(result).toEqual({
      positions: [],
      hasUnvalued: false,
      partial: false,
      failed: [],
    });
  });

  it("fails loud with kind config when the Helius key is missing", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    install(() => undefined);
    const err = await getDefiPositions([wallet()]).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect(err.kind).toBe("config");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detects owner-account positions from zero-length data slices", async () => {
    const w = wallet();
    install((_url, rpc) => {
      if (
        rpc?.method === "getProgramAccounts" &&
        programOf(rpc) === MARGINFI &&
        memcmpBytes(rpc) === w
      ) {
        return json({ result: [sliced("acc1"), sliced("acc2")] });
      }
      return undefined;
    });
    const result = await getDefiPositions([w]);
    expect(result.partial).toBe(false);
    expect(result.positions).toEqual([
      {
        wallet: w,
        protocol: "marginfi",
        type: "position",
        mint: null,
        symbol: null,
        valueUsd: null,
        count: 2,
      },
    ]);
    expect(result.hasUnvalued).toBe(true);
  });

  it("claims position NFTs per protocol and reports unmatched ones", async () => {
    const w = wallet();
    install((_url, rpc) => {
      if (rpc?.method === "getTokenAccountsByOwner") {
        const programId = (rpc.params[1] as { programId: string }).programId;
        return programId.startsWith("Tokenkeg")
          ? json({ result: { value: [nftAccount(NFT_A), nftAccount(NFT_B)] } })
          : json({ result: { value: [] } });
      }
      if (
        rpc?.method === "getProgramAccounts" &&
        programOf(rpc) === WHIRLPOOL &&
        memcmpBytes(rpc) === NFT_A
      ) {
        return json({ result: [sliced("pos")] });
      }
      return undefined;
    });
    const result = await getDefiPositions([w]);
    expect(result.positions.map((p) => [p.protocol, p.type, p.count])).toEqual([
      ["orca-whirlpool", "position", 1],
      ["unknown", "unmatched-nft", 1],
    ]);
  });

  it("does not count an NFT detected by one protocol as unscanned when another probe fails", async () => {
    const w = wallet();
    install((_url, rpc) => {
      if (rpc?.method === "getTokenAccountsByOwner") {
        const programId = (rpc.params[1] as { programId: string }).programId;
        return programId.startsWith("Tokenkeg")
          ? json({ result: { value: [nftAccount(NFT_A)] } })
          : json({ result: { value: [] } });
      }
      if (rpc?.method === "getProgramAccounts" && memcmpBytes(rpc) === NFT_A) {
        return programOf(rpc) === WHIRLPOOL
          ? json({ result: [sliced("pos")] })
          : json({}, 503);
      }
      return undefined;
    });
    const result = await settle(getDefiPositions([w]));
    expect(result.partial).toBe(true);
    expect(result.positions.map((p) => [p.protocol, p.type, p.count])).toEqual([
      ["orca-whirlpool", "position", 1],
    ]);
  });

  it("keeps successful NFT detections when one probe fails, counting it as unscanned", async () => {
    const w = wallet();
    install((_url, rpc) => {
      if (rpc?.method === "getTokenAccountsByOwner") {
        const programId = (rpc.params[1] as { programId: string }).programId;
        return programId.startsWith("Tokenkeg")
          ? json({ result: { value: [nftAccount(NFT_A), nftAccount(NFT_B)] } })
          : json({ result: { value: [] } });
      }
      if (
        rpc?.method === "getProgramAccounts" &&
        programOf(rpc) === WHIRLPOOL
      ) {
        if (memcmpBytes(rpc) === NFT_A)
          return json({ result: [sliced("pos")] });
        if (memcmpBytes(rpc) === NFT_B) return json({}, 503);
      }
      return undefined;
    });
    const result = await settle(getDefiPositions([w]));
    expect(result.partial).toBe(true);
    expect(result.failed).toEqual([{ wallet: w, source: "position-nfts" }]);
    expect(result.positions.map((p) => [p.protocol, p.type, p.count])).toEqual([
      ["orca-whirlpool", "position", 1],
      ["unknown", "unscanned-nft", 1],
    ]);
  });

  it("degrades one failed source to partial, keeps the rest, and does not cache", async () => {
    const w = wallet();
    install((url, rpc) => {
      if (url.startsWith("https://api.helius.xyz/")) return json({}, 503);
      if (rpc?.method === "getProgramAccounts" && programOf(rpc) === MARGINFI) {
        return json({ result: [sliced("acc1")] });
      }
      return undefined;
    });
    const first = await settle(getDefiPositions([w]));
    expect(first.partial).toBe(true);
    expect(first.failed).toEqual([{ wallet: w, source: "interactions" }]);
    expect(first.positions.map((p) => p.protocol)).toEqual(["marginfi"]);
    const calls = fetchMock.mock.calls.length;
    await settle(getDefiPositions([w]));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("caches a complete scan", async () => {
    const w = wallet();
    install(() => undefined);
    await getDefiPositions([w]);
    const calls = fetchMock.mock.calls.length;
    await getDefiPositions([w]);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("degrades an RPC result of the wrong shape", async () => {
    const w = wallet();
    install((_url, rpc) => {
      if (rpc?.method === "getProgramAccounts") {
        return json({ result: { not: "an array" } });
      }
      return undefined;
    });
    const result = await settle(getDefiPositions([w]));
    expect(result.partial).toBe(true);
    expect(result.failed.map((f) => f.source).sort()).toEqual([
      "kamino-lend",
      "owner-accounts",
    ]);
  });

  it("degrades an RPC error envelope that is not an auth failure", async () => {
    const w = wallet();
    install((_url, rpc) => {
      if (rpc?.method === "getProgramAccounts" && programOf(rpc) === MARGINFI) {
        return json({ error: { code: -32010, message: "too many accounts" } });
      }
      return undefined;
    });
    const result = await getDefiPositions([w]);
    expect(result.failed).toEqual([{ wallet: w, source: "owner-accounts" }]);
  });

  it("fails fast on a fatal source without waiting for slow siblings", async () => {
    let releaseSibling!: () => void;
    const siblingDone = new Promise<void>((r) => {
      releaseSibling = r;
    });
    install((url, rpc) => {
      if (url.startsWith("https://api.helius.xyz/")) return json({}, 401);
      if (rpc?.method === "getTokenAccountsByOwner") {
        return new Promise<Response>((resolve) => {
          siblingDone.then(() => resolve(json({ result: { value: [] } })));
        }) as unknown as Response;
      }
      return undefined;
    });
    let settled = false;
    const p = getDefiPositions([wallet()])
      .catch((e) => e)
      .then((e) => {
        settled = true;
        return e;
      });
    await settle(Promise.resolve());
    expect(settled).toBe(true);
    expect(await p).toBeInstanceOf(ProviderAuthError);
    const siblingSignals = fetchMock.mock.calls
      .filter((c) => parseRpc(c[1])?.method === "getTokenAccountsByOwner")
      .map((c) => c[1]?.signal as AbortSignal);
    expect(siblingSignals.length).toBeGreaterThan(0);
    expect(siblingSignals.every((sig) => sig.aborted)).toBe(true);
    releaseSibling();
  });

  it("rethrows auth failures instead of degrading", async () => {
    install((url) =>
      url.startsWith("https://api.helius.xyz/") ? json({}, 401) : undefined,
    );
    const err = await settle(getDefiPositions([wallet()]).catch((e) => e));
    expect(err).toBeInstanceOf(ProviderAuthError);
  });

  it("rethrows JSON-RPC auth error codes", async () => {
    install((_url, rpc) =>
      rpc?.method === "getTokenAccountsByOwner"
        ? json({ error: { code: -32401, message: "unauthorized" } })
        : undefined,
    );
    const err = await settle(getDefiPositions([wallet()]).catch((e) => e));
    expect(err).toBeInstanceOf(ProviderAuthError);
  });
});
