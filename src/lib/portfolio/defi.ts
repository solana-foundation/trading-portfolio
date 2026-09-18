import { getTokenMeta } from "@/lib/portfolio/birdeye";
import { TtlCache } from "@/lib/portfolio/cache";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import type { DefiPositionRow } from "@/lib/portfolio/types";

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

const OWNER_ACCOUNT_PROTOCOLS = [
  { name: "kamino-farms", program: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr", ownerOffset: 48 },
  { name: "marginfi", program: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", ownerOffset: 40 },
  { name: "solend", program: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo", ownerOffset: 42 },
  { name: "meteora-dlmm", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", ownerOffset: 40 },
  { name: "lulo", program: "FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q", ownerOffset: 16 },
  { name: "drift", program: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", ownerOffset: 8 },
];

const POSITION_NFT_PROTOCOLS = [
  { name: "orca-whirlpool", program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", mintOffset: 40 },
  { name: "raydium-clmm", program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", mintOffset: 9 },
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
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

function rpcUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set");
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

type RpcResp<T> = { result?: T; error?: { message?: string } };

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const resp = await fetchJSON<RpcResp<T>>(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (resp.error) {
    throw new Error(`rpc ${method}: ${resp.error.message || "failed"}`);
  }
  return resp.result as T;
}

type ProgramAccount = { pubkey: string; account: { data: [string, string] } };

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const reserveMintCache = new TtlCache<string>(2_000, 24 * 60 * 60 * 1000);

async function kaminoDeposits(wallet: string): Promise<DefiPositionRow[]> {
  const obligations = await rpc<ProgramAccount[]>("getProgramAccounts", [
    KLEND,
    {
      encoding: "base64",
      filters: [
        { memcmp: { offset: OBLIGATION_OWNER_OFFSET, bytes: wallet } },
      ],
    },
  ]);
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
  if (unknownReserves.length > 0) {
    const infos = await rpc<{ value: Array<{ data: [string, string] } | null> }>(
      "getMultipleAccounts",
      [unknownReserves, { encoding: "base64" }],
    );
    unknownReserves.forEach((reserve, i) => {
      const info = infos.value[i];
      if (!info) return;
      const data = Buffer.from(info.data[0], "base64");
      reserveMintCache.set(
        reserve,
        b58encode(data.subarray(RESERVE_MINT_OFFSET, RESERVE_MINT_OFFSET + 32)),
      );
    });
  }

  const rows: DefiPositionRow[] = [];
  for (const d of deposits) {
    const mint = reserveMintCache.get(d.reserve) || null;
    const meta = mint ? await getTokenMeta(mint) : null;
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

async function ownerAccountPositions(wallet: string): Promise<DefiPositionRow[]> {
  const rows: DefiPositionRow[] = [];
  for (const proto of OWNER_ACCOUNT_PROTOCOLS) {
    const res = await rpc<ProgramAccount[]>("getProgramAccounts", [
      proto.program,
      {
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 },
        filters: [{ memcmp: { offset: proto.ownerOffset, bytes: wallet } }],
      },
    ]);
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
): Promise<{ rows: DefiPositionRow[]; unmatchedNfts: number; unscannedNfts: number }> {
  const nftMints: string[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const res = await rpc<{
      value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }>;
    }>("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed" }]);
    for (const acc of res.value) {
      const info = acc.account.data.parsed.info;
      if (info.tokenAmount.decimals === 0 && info.tokenAmount.amount === "1") {
        nftMints.push(info.mint);
      }
    }
  }
  const scanned = nftMints.slice(0, NFT_SCAN_CAP);
  const claimed = new Set<string>();
  const rows: DefiPositionRow[] = [];
  for (const proto of POSITION_NFT_PROTOCOLS) {
    const hits = await mapLimit(scanned, NFT_PROBE_CONCURRENCY, (mint) =>
      rpc<ProgramAccount[]>("getProgramAccounts", [
        proto.program,
        {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: proto.mintOffset, bytes: mint } }],
        },
      ]),
    );
    let count = 0;
    hits.forEach((res, i) => {
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
  return {
    rows,
    unmatchedNfts: scanned.filter((m) => !claimed.has(m)).length,
    unscannedNfts: nftMints.length - scanned.length,
  };
}

async function unknownInteractions(wallet: string): Promise<DefiPositionRow[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  const txs = await fetchJSON<Array<{ instructions?: Array<{ programId?: string }> }>>(
    `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=100`,
  );
  if (!Array.isArray(txs)) return [];
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

const defiCache = new TtlCache<DefiPositionRow[]>(500, 5 * 60 * 1000);

export async function getDefiPositions(
  wallets: string[],
): Promise<{ positions: DefiPositionRow[]; hasUnvalued: boolean }> {
  const perWallet = await mapLimit(wallets, WALLET_CONCURRENCY, async (wallet) => {
    const cached = defiCache.get(wallet);
    if (cached) return cached;
    const [kamino, ownerRows, nft, unknown] = await Promise.all([
      kaminoDeposits(wallet),
      ownerAccountPositions(wallet),
      nftPositions(wallet),
      unknownInteractions(wallet),
    ]);
    const rows = [...kamino, ...ownerRows, ...nft.rows, ...unknown];
    if (nft.unmatchedNfts > 0) {
      rows.push({
        wallet,
        protocol: "unknown",
        type: "unmatched-nft",
        mint: null,
        symbol: null,
        valueUsd: null,
        count: nft.unmatchedNfts,
      });
    }
    if (nft.unscannedNfts > 0) {
      rows.push({
        wallet,
        protocol: "unknown",
        type: "unscanned-nft",
        mint: null,
        symbol: null,
        valueUsd: null,
        count: nft.unscannedNfts,
      });
    }
    defiCache.set(wallet, rows);
    return rows;
  });
  const positions = perWallet
    .flat()
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  return {
    positions,
    hasUnvalued: positions.some((p) => p.valueUsd === null),
  };
}
