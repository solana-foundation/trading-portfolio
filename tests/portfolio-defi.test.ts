import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefiPositions } from "@/lib/portfolio/defi";
import { ProviderAuthError, VendorError } from "@/lib/portfolio/errors";

const MARGINFI = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const NFT_A = "NftA11111111111111111111111111111111111111";
const NFT_B = "NftB11111111111111111111111111111111111111";
const PHOENIX = "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih";
const PHOENIX_HOST = "perp-api.phoenix.trade";
const PHOENIX_API = `https://${PHOENIX_HOST}`;

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

const usd = (ui: number) => ({ value: Math.round(ui * 1e6), decimals: 6 });

function traderView(
  authority: string,
  subaccountIndex: number,
  over: Record<string, unknown> = {},
) {
  return {
    traderKey: `trader${subaccountIndex}`,
    authority,
    traderPdaIndex: 0,
    traderSubaccountIndex: subaccountIndex,
    collateralBalance: usd(0),
    unrealizedPnl: usd(0),
    unsettledFundingOwed: usd(0),
    portfolioValue: usd(0),
    maintenanceMargin: usd(0),
    riskState: "zeroCollateralNoPositions",
    riskTier: "safe",
    positions: [],
    ...over,
  };
}

function traderState(
  subaccounts: Array<{ subaccountIndex: number; sol?: string }>,
) {
  return {
    snapshot: {
      subaccounts: subaccounts.map((s) => ({
        subaccountIndex: s.subaccountIndex,
        collateral: "0",
        spotCollaterals: [
          { symbol: "SOL", balance: s.sol ?? "0", decimals: 9 },
        ],
      })),
    },
  };
}

function phoenix(
  w: string,
  views: Record<string, unknown>,
  state: unknown,
): Handler {
  return (url, rpc) => {
    if (
      rpc?.method === "getProgramAccounts" &&
      programOf(rpc) === PHOENIX &&
      memcmpBytes(rpc) === w
    ) {
      return json({ result: Object.keys(views).map(sliced) });
    }
    if (url.startsWith(`${PHOENIX_API}/v1/view/trader/`)) {
      const view = views[url.split("/").pop() ?? ""];
      return view instanceof Response ? view.clone() : json(view);
    }
    if (url.startsWith(`${PHOENIX_API}/v1/trader/state/${w}`)) {
      return json(state);
    }
    return undefined;
  };
}

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
      "phoenix",
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

  it("values Phoenix cross and isolated accounts and skips empty ones", async () => {
    const w = wallet();
    install(
      phoenix(
        w,
        {
          trader0: traderView(w, 0, {
            collateralBalance: usd(100),
            unrealizedPnl: usd(-2.5),
            unsettledFundingOwed: usd(0.25),
            portfolioValue: usd(97.75),
            maintenanceMargin: usd(4),
            riskState: "healthy",
            positions: [
              {
                symbol: "SOL",
                positionSize: { value: -150, decimals: 2 },
                entryPrice: usd(120),
                positionValue: usd(-182.5),
                unrealizedPnl: usd(-2.5),
                liquidationPrice: { value: 180500, decimals: 3 },
              },
              {
                symbol: "BTC",
                positionSize: { value: "10", decimals: 4 },
                entryPrice: usd(85220),
                positionValue: usd(85.22),
                unrealizedPnl: usd(0),
                liquidationPrice: { value: -1, decimals: 0 },
              },
            ],
          }),
          trader1: traderView(w, 1),
          trader2: traderView(w, 2, {
            collateralBalance: usd(3),
            portfolioValue: usd(3),
            riskState: "healthy",
          }),
        },
        traderState([
          { subaccountIndex: 0 },
          { subaccountIndex: 1 },
          { subaccountIndex: 2 },
        ]),
      ),
    );
    const result = await getDefiPositions([w]);
    expect(result.partial).toBe(false);
    expect(result.hasUnvalued).toBe(false);
    expect(result.positions).toEqual([
      {
        wallet: w,
        protocol: "phoenix",
        type: "perp-account",
        mint: null,
        symbol: null,
        valueUsd: 97.75,
        count: 2,
        perp: {
          traderKey: "trader0",
          pdaIndex: 0,
          subaccountIndex: 0,
          margin: "cross",
          equityUsd: 97.75,
          collateralUsd: 100,
          spotCollateral: [],
          unrealizedPnlUsd: -2.5,
          unsettledFundingUsd: 0.25,
          maintenanceMarginUsd: 4,
          riskState: "healthy",
          riskTier: "safe",
          positions: [
            {
              symbol: "SOL",
              size: -1.5,
              entryPrice: 120,
              notionalUsd: 182.5,
              unrealizedPnlUsd: -2.5,
              liquidationPrice: 180.5,
            },
            {
              symbol: "BTC",
              size: 0.001,
              entryPrice: 85220,
              notionalUsd: 85.22,
              unrealizedPnlUsd: 0,
              liquidationPrice: null,
            },
          ],
        },
      },
      expect.objectContaining({
        valueUsd: 3,
        count: 0,
        perp: expect.objectContaining({
          traderKey: "trader2",
          subaccountIndex: 2,
          margin: "isolated",
        }),
      }),
    ]);
  });

  it("leaves a Phoenix account holding spot collateral unvalued", async () => {
    const w = wallet();
    install(
      phoenix(
        w,
        {
          trader0: traderView(w, 0, {
            collateralBalance: usd(10),
            portfolioValue: usd(90),
            riskState: "healthy",
          }),
        },
        traderState([{ subaccountIndex: 0, sol: "1500000000" }]),
      ),
    );
    const result = await getDefiPositions([w]);
    expect(result.hasUnvalued).toBe(true);
    expect(result.positions).toEqual([
      expect.objectContaining({
        protocol: "phoenix",
        valueUsd: null,
        perp: expect.objectContaining({
          equityUsd: 90,
          spotCollateral: [{ symbol: "SOL", amount: 1.5 }],
        }),
      }),
    ]);
  });

  it("degrades Phoenix when the state snapshot omits a discovered subaccount", async () => {
    const w = wallet();
    install(
      phoenix(
        w,
        {
          trader0: traderView(w, 0, {
            collateralBalance: usd(5),
            portfolioValue: usd(5),
            riskState: "healthy",
          }),
          trader3: traderView(w, 3, {
            collateralBalance: usd(1),
            portfolioValue: usd(90),
            riskState: "healthy",
          }),
        },
        traderState([{ subaccountIndex: 0 }]),
      ),
    );
    const result = await getDefiPositions([w]);
    expect(result.failed).toEqual([{ wallet: w, source: "phoenix" }]);
    expect(result.positions).toEqual([]);
  });

  it("reads the state of every Phoenix PDA index concurrently", async () => {
    const w = wallet();
    const base = phoenix(
      w,
      {
        trader0: traderView(w, 0, {
          collateralBalance: usd(5),
          portfolioValue: usd(5),
          riskState: "healthy",
        }),
        trader1: traderView(w, 0, {
          traderPdaIndex: 1,
          collateralBalance: usd(7),
          portfolioValue: usd(7),
          riskState: "healthy",
        }),
      },
      traderState([{ subaccountIndex: 0 }]),
    );
    const pending: Array<() => void> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/trader/state/")) {
        await new Promise<void>((resolve) => pending.push(resolve));
      }
      const res = base(url, parseRpc(init));
      if (res) return res;
      if (url.startsWith("https://api.helius.xyz/")) return json([]);
      return json({
        result:
          parseRpc(init)?.method === "getProgramAccounts" ? [] : { value: [] },
      });
    });
    const p = getDefiPositions([w]);
    await flush();
    await flush();
    expect(pending).toHaveLength(2);
    for (const release of pending) release();
    const result = await p;
    expect(result.positions.map((r) => r.valueUsd)).toEqual([7, 5]);
    expect(
      fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/v1/trader/state/"))
        .map((u) => new URL(u).searchParams.get("traderPdaIndex"))
        .sort(),
    ).toEqual(["0", "1"]);
  });

  it("keeps Phoenix interaction evidence only when no account is valued", async () => {
    const txs = [
      { instructions: [{ programId: PHOENIX }, { programId: PHOENIX }] },
    ];
    const idle = wallet();
    install((url) =>
      url.startsWith("https://api.helius.xyz/") ? json(txs) : undefined,
    );
    const without = await getDefiPositions([idle]);
    expect(without.positions).toEqual([
      {
        wallet: idle,
        protocol: "phoenix",
        type: "interaction",
        mint: null,
        symbol: null,
        valueUsd: null,
        count: 2,
        programId: PHOENIX,
      },
    ]);

    const active = wallet();
    const base = phoenix(
      active,
      {
        trader0: traderView(active, 0, {
          collateralBalance: usd(5),
          portfolioValue: usd(5),
          riskState: "healthy",
        }),
      },
      traderState([{ subaccountIndex: 0 }]),
    );
    install((url, rpc) =>
      url.startsWith("https://api.helius.xyz/") ? json(txs) : base(url, rpc),
    );
    const withAccount = await getDefiPositions([active]);
    expect(withAccount.positions.map((r) => r.type)).toEqual(["perp-account"]);
  });

  it("does not let Phoenix take one of the eight interaction slots", async () => {
    const others = Array.from({ length: 8 }, (_, i) => `Other${i}`);
    const txs = [
      {
        instructions: [
          { programId: PHOENIX },
          { programId: PHOENIX },
          ...others.map((programId) => ({ programId })),
        ],
      },
    ];
    const w = wallet();
    const base = phoenix(
      w,
      {
        trader0: traderView(w, 0, {
          collateralBalance: usd(5),
          portfolioValue: usd(5),
          riskState: "healthy",
        }),
      },
      traderState([{ subaccountIndex: 0 }]),
    );
    install((url, rpc) =>
      url.startsWith("https://api.helius.xyz/") ? json(txs) : base(url, rpc),
    );
    const result = await getDefiPositions([w]);
    expect(
      result.positions
        .filter((r) => r.type === "interaction")
        .map((r) => r.programId)
        .sort(),
    ).toEqual(others);
  });

  it("makes no Phoenix API call for a wallet without trader accounts", async () => {
    install(() => undefined);
    await getDefiPositions([wallet()]);
    expect(
      fetchMock.mock.calls.some(
        (c) => new URL(String(c[0])).host === PHOENIX_HOST,
      ),
    ).toBe(false);
  });

  it.each([
    ["an unknown trader", () => json({ error: "Trader not found" }, 404)],
    ["a server error", () => json({ error: "boom" }, 500)],
    ["a view of the wrong shape", () => json({ authority: 1 })],
  ])("degrades the whole Phoenix source on %s", async (_name, bad) => {
    const w = wallet();
    install(
      phoenix(
        w,
        {
          trader0: traderView(w, 0, {
            collateralBalance: usd(5),
            portfolioValue: usd(5),
            riskState: "healthy",
          }),
          trader1: bad(),
        },
        traderState([{ subaccountIndex: 0 }, { subaccountIndex: 1 }]),
      ),
    );
    const result = await settle(getDefiPositions([w]));
    expect(result.partial).toBe(true);
    expect(result.failed).toEqual([{ wallet: w, source: "phoenix" }]);
    expect(result.positions).toEqual([]);
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
