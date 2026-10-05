import { z } from "zod";
import { getTokenMetas } from "@/lib/portfolio/birdeye";
import { TtlCache } from "@/lib/portfolio/cache";
import { createLimiter, mapLimit } from "@/lib/portfolio/concurrency";
import {
  describeError,
  ProviderAuthError,
  VendorError,
} from "@/lib/portfolio/errors";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import {
  heliusApiKey,
  heliusGate,
  heliusRpcUrl,
  isAuthError,
  rpcResponse,
} from "@/lib/portfolio/tx-provider";
import type { DefiPositionRow, PerpAccount } from "@/lib/portfolio/types";

const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const SF = 2 ** 60;
const OBLIGATION_DEPOSITS_OFFSET = 96;
const OBLIGATION_DEPOSIT_STRIDE = 136;
const OBLIGATION_DEPOSIT_COUNT = 8;
const OBLIGATION_OWNER_OFFSET = 64;
const RESERVE_MINT_OFFSET = 128;
const NFT_SCAN_CAP = 40;
const MIN_POSITION_USD = 0.01;
const WALLET_CONCURRENCY = 4;
const NFT_PROBE_CONCURRENCY = 5;
const ACCOUNTS_PER_LOOKUP = 100;

const PHOENIX = "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih";
const PHOENIX_API = "https://perp-api.phoenix.trade";
const PHOENIX_TRADER_DISCRIMINATOR = "7vSQjpi9Yx8";
const PHOENIX_AUTHORITY_OFFSET = 56;
const PHOENIX_CONCURRENCY = 8;
const PHOENIX_EMPTY = "zeroCollateralNoPositions";

const phoenixGate = createLimiter(PHOENIX_CONCURRENCY);

const OWNER_ACCOUNT_PROTOCOLS = [
  {
    name: "kamino-farms",
    program: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
    ownerOffset: 48,
  },
  {
    name: "marginfi",
    program: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    ownerOffset: 40,
  },
  {
    name: "solend",
    program: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo",
    ownerOffset: 42,
  },
  {
    name: "meteora-dlmm",
    program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    ownerOffset: 40,
  },
  {
    name: "lulo",
    program: "FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q",
    ownerOffset: 16,
  },
  {
    name: "drift",
    program: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
    ownerOffset: 8,
  },
];

const POSITION_NFT_PROTOCOLS = [
  {
    name: "orca-whirlpool",
    program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    mintOffset: 40,
  },
  {
    name: "raydium-clmm",
    program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    mintOffset: 9,
  },
];

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

const INFRA_PROGRAMS = new Set([
  ...TOKEN_PROGRAMS,
  ...OWNER_ACCOUNT_PROTOCOLS.map((p) => p.program),
  ...POSITION_NFT_PROTOCOLS.map((p) => p.program),
  KLEND,
  PHOENIX,
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu",
  "AddressLookupTab1e1111111111111111111111111",
]);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = `1${out}`;
    else break;
  }
  return out;
}

async function rpc<S extends z.ZodType>(
  method: string,
  params: unknown[],
  result: S,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const resp = await fetchJSON(heliusRpcUrl(), {
    vendor: "helius",
    schema: rpcResponse(result),
    gate: heliusGate,
    signal,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
  });
  if (resp.error) {
    const msg = resp.error.message || JSON.stringify(resp.error);
    if (isAuthError(resp.error.code ?? undefined, msg)) {
      throw new ProviderAuthError({
        vendor: "helius",
        path: method,
        message: `helius rpc: ${msg}`,
      });
    }
    throw new VendorError({
      vendor: "helius",
      kind: "api",
      path: method,
      message: `rpc ${method}: ${msg}`,
    });
  }
  if (resp.result == null) {
    throw new VendorError({
      vendor: "helius",
      kind: "shape",
      path: method,
      message: `rpc ${method}: missing result`,
    });
  }
  return resp.result;
}

const accountDataSchema = z.tuple([z.string(), z.string()]);

const programAccountsSchema = z.array(
  z.looseObject({
    pubkey: z.string(),
    account: z.looseObject({ data: accountDataSchema }),
  }),
);

const multipleAccountsSchema = z.looseObject({
  value: z.array(z.looseObject({ data: accountDataSchema }).nullable()),
});

const parsedTokenAccountsSchema = z.looseObject({
  value: z.array(
    z.looseObject({
      account: z.looseObject({
        data: z.looseObject({
          parsed: z.looseObject({
            info: z.looseObject({
              mint: z.string(),
              tokenAmount: z.looseObject({
                amount: z.string(),
                decimals: z.number(),
              }),
            }),
          }),
        }),
      }),
    }),
  ),
});

const reserveMintCache = new TtlCache<string>(2_000, 24 * 60 * 60 * 1000);

async function kaminoDeposits(
  wallet: string,
  signal: AbortSignal,
): Promise<DefiPositionRow[]> {
  const obligations = await rpc(
    "getProgramAccounts",
    [
      KLEND,
      {
        encoding: "base64",
        filters: [
          { memcmp: { offset: OBLIGATION_OWNER_OFFSET, bytes: wallet } },
        ],
      },
    ],
    programAccountsSchema,
    signal,
  );
  const deposits: Array<{ reserve: string; valueUsd: number }> = [];
  for (const acc of obligations) {
    const data = Buffer.from(acc.account.data[0], "base64");
    for (let i = 0; i < OBLIGATION_DEPOSIT_COUNT; i++) {
      const base = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_DEPOSIT_STRIDE;
      if (base + 56 > data.length) break;
      const reserve = b58encode(data.subarray(base, base + 32));
      const hi = data.readBigUInt64LE(base + 48);
      const lo = data.readBigUInt64LE(base + 40);
      const valueUsd = Number((hi << 64n) + lo) / SF;
      if (valueUsd > MIN_POSITION_USD) deposits.push({ reserve, valueUsd });
    }
  }
  if (deposits.length === 0) return [];

  const unknownReserves = deposits
    .map((d) => d.reserve)
    .filter((r) => reserveMintCache.get(r) === undefined);
  for (let i = 0; i < unknownReserves.length; i += ACCOUNTS_PER_LOOKUP) {
    const batch = unknownReserves.slice(i, i + ACCOUNTS_PER_LOOKUP);
    const infos = await rpc(
      "getMultipleAccounts",
      [batch, { encoding: "base64" }],
      multipleAccountsSchema,
      signal,
    );
    batch.forEach((reserve, j) => {
      const info = infos.value[j];
      if (!info) return;
      const data = Buffer.from(info.data[0], "base64");
      reserveMintCache.set(
        reserve,
        b58encode(data.subarray(RESERVE_MINT_OFFSET, RESERVE_MINT_OFFSET + 32)),
      );
    });
  }

  const mints = deposits
    .map((d) => reserveMintCache.get(d.reserve))
    .filter((m): m is string => Boolean(m));
  const metas = await getTokenMetas(mints);
  const rows: DefiPositionRow[] = [];
  for (const d of deposits) {
    const mint = reserveMintCache.get(d.reserve) || null;
    const meta = mint ? metas.get(mint) : undefined;
    rows.push({
      wallet,
      protocol: "kamino-lend",
      type: "deposit",
      mint,
      symbol: meta?.symbol || null,
      valueUsd: d.valueUsd,
      count: 1,
    });
  }
  return rows;
}

async function ownerAccountPositions(
  wallet: string,
  signal: AbortSignal,
): Promise<DefiPositionRow[]> {
  const rows: DefiPositionRow[] = [];
  for (const proto of OWNER_ACCOUNT_PROTOCOLS) {
    const res = await rpc(
      "getProgramAccounts",
      [
        proto.program,
        {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: proto.ownerOffset, bytes: wallet } }],
        },
      ],
      programAccountsSchema,
      signal,
    );
    if (res.length > 0) {
      rows.push({
        wallet,
        protocol: proto.name,
        type: "position",
        mint: null,
        symbol: null,
        valueUsd: null,
        count: res.length,
      });
    }
  }
  return rows;
}

async function nftPositions(
  wallet: string,
  signal: AbortSignal,
): Promise<{ rows: DefiPositionRow[]; degraded: boolean }> {
  const nftMints: string[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const res = await rpc(
      "getTokenAccountsByOwner",
      [wallet, { programId }, { encoding: "jsonParsed" }],
      parsedTokenAccountsSchema,
      signal,
    );
    for (const acc of res.value) {
      const info = acc.account.data.parsed.info;
      if (info.tokenAmount.decimals === 0 && info.tokenAmount.amount === "1") {
        nftMints.push(info.mint);
      }
    }
  }
  const scanned = nftMints.slice(0, NFT_SCAN_CAP);
  const claimed = new Set<string>();
  const unprobed = new Set<string>();
  const rows: DefiPositionRow[] = [];
  for (const proto of POSITION_NFT_PROTOCOLS) {
    const hits = await mapLimit(scanned, NFT_PROBE_CONCURRENCY, (mint) =>
      rpc(
        "getProgramAccounts",
        [
          proto.program,
          {
            encoding: "base64",
            dataSlice: { offset: 0, length: 0 },
            filters: [{ memcmp: { offset: proto.mintOffset, bytes: mint } }],
          },
        ],
        programAccountsSchema,
        signal,
      ).catch((e: unknown) => {
        if (!isDegradable(e)) throw e;
        console.warn(
          `portfolio: defi probe ${proto.name} failed for ${mint.slice(0, 4)}…: ${describeError(e)}`,
        );
        return null;
      }),
    );
    let count = 0;
    hits.forEach((res, i) => {
      if (res === null) {
        unprobed.add(scanned[i]);
        return;
      }
      if (res.length > 0) {
        count += 1;
        claimed.add(scanned[i]);
      }
    });
    if (count > 0) {
      rows.push({
        wallet,
        protocol: proto.name,
        type: "position",
        mint: null,
        symbol: null,
        valueUsd: null,
        count,
      });
    }
  }
  const unmatchedNfts = scanned.filter(
    (m) => !claimed.has(m) && !unprobed.has(m),
  ).length;
  const unscannedNfts =
    nftMints.length -
    scanned.length +
    [...unprobed].filter((m) => !claimed.has(m)).length;
  if (unmatchedNfts > 0) {
    rows.push({
      wallet,
      protocol: "unknown",
      type: "unmatched-nft",
      mint: null,
      symbol: null,
      valueUsd: null,
      count: unmatchedNfts,
    });
  }
  if (unscannedNfts > 0) {
    rows.push({
      wallet,
      protocol: "unknown",
      type: "unscanned-nft",
      mint: null,
      symbol: null,
      valueUsd: null,
      count: unscannedNfts,
    });
  }
  return { rows, degraded: unprobed.size > 0 };
}

const phoenixAmount = z
  .looseObject({
    value: z.union([z.number(), z.string()]),
    decimals: z.number().int().min(0).max(30),
  })
  .transform((a) => Number(a.value) / 10 ** a.decimals)
  .pipe(z.number());

const phoenixTraderSchema = z.looseObject({
  authority: z.string(),
  traderPdaIndex: z.number().int().min(0),
  traderSubaccountIndex: z.number().int().min(0),
  collateralBalance: phoenixAmount,
  unrealizedPnl: phoenixAmount,
  unsettledFundingOwed: phoenixAmount,
  portfolioValue: phoenixAmount,
  maintenanceMargin: phoenixAmount,
  riskState: z.string(),
  riskTier: z.string(),
  positions: z.array(
    z.looseObject({
      symbol: z.string(),
      positionSize: phoenixAmount,
      entryPrice: phoenixAmount,
      positionValue: phoenixAmount,
      unrealizedPnl: phoenixAmount,
      liquidationPrice: phoenixAmount.nullish(),
    }),
  ),
});

const phoenixStateSchema = z.looseObject({
  snapshot: z.looseObject({
    subaccounts: z.array(
      z.looseObject({
        subaccountIndex: z.number().int().min(0),
        spotCollaterals: z
          .array(
            z.looseObject({
              symbol: z.string(),
              balance: z.string(),
              decimals: z.number().int().min(0).max(30),
            }),
          )
          .nullish(),
      }),
    ),
  }),
});

async function phoenixSpotCollateral(
  wallet: string,
  pdaIndex: number,
  signal: AbortSignal,
): Promise<Map<number, PerpAccount["spotCollateral"]>> {
  const state = await fetchJSON(
    `${PHOENIX_API}/v1/trader/state/${wallet}?traderPdaIndex=${pdaIndex}`,
    {
      vendor: "phoenix",
      schema: phoenixStateSchema,
      gate: phoenixGate,
      signal,
    },
  );
  const bySubaccount = new Map<number, PerpAccount["spotCollateral"]>();
  for (const sub of state.snapshot.subaccounts) {
    const held: PerpAccount["spotCollateral"] = [];
    for (const spot of sub.spotCollaterals || []) {
      const amount = Number(spot.balance) / 10 ** spot.decimals;
      if (!Number.isFinite(amount)) {
        throw new VendorError({
          vendor: "phoenix",
          kind: "shape",
          path: "/v1/trader/state",
          message: `phoenix spot collateral balance is not a number: ${spot.balance}`,
        });
      }
      if (amount !== 0) held.push({ symbol: spot.symbol, amount });
    }
    bySubaccount.set(sub.subaccountIndex, held);
  }
  return bySubaccount;
}

async function phoenixPerps(
  wallet: string,
  signal: AbortSignal,
): Promise<DefiPositionRow[]> {
  const accounts = await rpc(
    "getProgramAccounts",
    [
      PHOENIX,
      {
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { memcmp: { offset: PHOENIX_AUTHORITY_OFFSET, bytes: wallet } },
          { memcmp: { offset: 0, bytes: PHOENIX_TRADER_DISCRIMINATOR } },
        ],
      },
    ],
    programAccountsSchema,
    signal,
  );
  if (accounts.length === 0) return [];
  const traders = await mapLimit(
    accounts,
    PHOENIX_CONCURRENCY,
    async (acc) => ({
      traderKey: acc.pubkey,
      view: await fetchJSON(`${PHOENIX_API}/v1/view/trader/${acc.pubkey}`, {
        vendor: "phoenix",
        schema: phoenixTraderSchema,
        gate: phoenixGate,
        signal,
      }),
    }),
  );
  const spotByPda = new Map<
    number,
    Map<number, PerpAccount["spotCollateral"]>
  >();
  for (const pdaIndex of new Set(traders.map((t) => t.view.traderPdaIndex))) {
    spotByPda.set(
      pdaIndex,
      await phoenixSpotCollateral(wallet, pdaIndex, signal),
    );
  }
  const rows: DefiPositionRow[] = [];
  for (const { traderKey, view } of traders) {
    if (view.authority !== wallet) {
      throw new VendorError({
        vendor: "phoenix",
        kind: "shape",
        path: "/v1/view/trader",
        message: `phoenix trader ${traderKey} reports a different authority`,
      });
    }
    const spotCollateral =
      spotByPda.get(view.traderPdaIndex)?.get(view.traderSubaccountIndex) || [];
    if (view.riskState === PHOENIX_EMPTY && spotCollateral.length === 0) {
      continue;
    }
    rows.push({
      wallet,
      protocol: "phoenix",
      type: "perp-account",
      mint: null,
      symbol: null,
      valueUsd: spotCollateral.length > 0 ? null : view.portfolioValue,
      count: view.positions.length,
      perp: {
        traderKey,
        pdaIndex: view.traderPdaIndex,
        subaccountIndex: view.traderSubaccountIndex,
        margin: view.traderSubaccountIndex === 0 ? "cross" : "isolated",
        equityUsd: view.portfolioValue,
        collateralUsd: view.collateralBalance,
        spotCollateral,
        unrealizedPnlUsd: view.unrealizedPnl,
        unsettledFundingUsd: view.unsettledFundingOwed,
        maintenanceMarginUsd: view.maintenanceMargin,
        riskState: view.riskState,
        riskTier: view.riskTier,
        positions: view.positions.map((p) => ({
          symbol: p.symbol,
          size: p.positionSize,
          entryPrice: p.entryPrice,
          notionalUsd: Math.abs(p.positionValue),
          unrealizedPnlUsd: p.unrealizedPnl,
          liquidationPrice:
            p.liquidationPrice == null || p.liquidationPrice < 0
              ? null
              : p.liquidationPrice,
        })),
      },
    });
  }
  return rows;
}

const interactionsSchema = z.array(
  z.looseObject({
    instructions: z
      .array(z.looseObject({ programId: z.string().nullish() }))
      .nullish(),
  }),
);

async function unknownInteractions(
  wallet: string,
  signal: AbortSignal,
): Promise<DefiPositionRow[]> {
  const txs = await fetchJSON(
    `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusApiKey()}&limit=100`,
    { vendor: "helius", schema: interactionsSchema, gate: heliusGate, signal },
  );
  const counts = new Map<string, number>();
  for (const tx of txs) {
    for (const ix of tx.instructions || []) {
      const pid = ix.programId;
      if (!pid || INFRA_PROGRAMS.has(pid)) continue;
      counts.set(pid, (counts.get(pid) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([program, txCount]) => ({
      wallet,
      protocol: "unknown",
      type: "interaction",
      mint: null,
      symbol: null,
      valueUsd: null,
      count: txCount,
      programId: program,
    }));
}

export type DefiScanSource =
  | "kamino-lend"
  | "owner-accounts"
  | "position-nfts"
  | "phoenix"
  | "interactions";

export type DefiScanFailure = { wallet: string; source: DefiScanSource };

type WalletScan = { rows: DefiPositionRow[]; failed: DefiScanFailure[] };

export type DefiPositionsResult = {
  positions: DefiPositionRow[];
  hasUnvalued: boolean;
  partial: boolean;
  failed: DefiScanFailure[];
};

const defiCache = new TtlCache<WalletScan>(500, 5 * 60 * 1000);

function isDegradable(e: unknown): boolean {
  if (!(e instanceof VendorError)) return false;
  if (e instanceof ProviderAuthError) return false;
  return e.kind !== "config";
}

async function scanWallet(wallet: string): Promise<WalletScan> {
  const controller = new AbortController();
  const { signal } = controller;
  type SourceResult = { rows: DefiPositionRow[]; degraded: boolean };
  const whole = (p: Promise<DefiPositionRow[]>): Promise<SourceResult> =>
    p.then((rows) => ({ rows, degraded: false }));
  const sources: Array<[DefiScanSource, () => Promise<SourceResult>]> = [
    ["kamino-lend", () => whole(kaminoDeposits(wallet, signal))],
    ["owner-accounts", () => whole(ownerAccountPositions(wallet, signal))],
    ["position-nfts", () => nftPositions(wallet, signal)],
    ["phoenix", () => whole(phoenixPerps(wallet, signal))],
    ["interactions", () => whole(unknownInteractions(wallet, signal))],
  ];
  const outcomes = await Promise.all(
    sources.map(([source, run]) =>
      run().then(
        (result) => ({ source, rows: result.rows, degraded: result.degraded }),
        (e: unknown) => {
          if (!isDegradable(e)) {
            controller.abort();
            throw e;
          }
          console.warn(
            `portfolio: defi source ${source} unavailable for ${wallet.slice(0, 4)}…: ${describeError(e)}`,
          );
          return { source, rows: null, degraded: true };
        },
      ),
    ),
  );
  const rows: DefiPositionRow[] = [];
  const failed: DefiScanFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.rows) rows.push(...outcome.rows);
    if (outcome.degraded) failed.push({ wallet, source: outcome.source });
  }
  return { rows, failed };
}

export async function getDefiPositions(
  wallets: string[],
): Promise<DefiPositionsResult> {
  const perWallet = await mapLimit(wallets, WALLET_CONCURRENCY, (wallet) =>
    defiCache.getOrFetch(
      wallet,
      () => scanWallet(wallet),
      (scan) => (scan.failed.length > 0 ? 0 : undefined),
    ),
  );
  const positions = perWallet
    .flatMap((s) => s.rows)
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const failed = perWallet.flatMap((s) => s.failed);
  return {
    positions,
    hasUnvalued: positions.some((p) => p.valueUsd === null),
    partial: failed.length > 0,
    failed,
  };
}
