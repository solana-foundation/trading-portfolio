import { z } from "zod";
import { TtlCache } from "@/lib/portfolio/cache";
import {
  createLimiter,
  type Limiter,
  mapLimit,
} from "@/lib/portfolio/concurrency";
import {
  describeError,
  ProviderAuthError,
  type Vendor,
  VendorError,
} from "@/lib/portfolio/errors";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import type { HeliusTx } from "@/lib/portfolio/swaps";

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const MAX_TOKEN_ACCOUNTS = 128;
const ACCOUNT_FETCH_CONCURRENCY = 8;
const HELIUS_CONCURRENCY = 8;
const TRITON_CONCURRENCY = 8;

export const heliusGate = createLimiter(HELIUS_CONCURRENCY);
const tritonGate = createLimiter(TRITON_CONCURRENCY);

export function heliusApiKey(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new VendorError({
      vendor: "helius",
      kind: "config",
      path: "env",
      message: "HELIUS_API_KEY is not set",
    });
  }
  return apiKey;
}

export function heliusRpcUrl(): string {
  return `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey()}`;
}

const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

export type TxFetchResult = {
  txs: HeliusTx[];
  truncated: boolean;
};

const txCache = new TtlCache<TxFetchResult>(1_000, 60 * 60 * 1000);

const rpcErrorSchema = z.looseObject({
  code: z.number().nullish(),
  message: z.string().nullish(),
});

export function rpcResponse<T extends z.ZodType>(result: T) {
  return z.looseObject({
    result: result.nullish(),
    error: rpcErrorSchema.nullish(),
  });
}

export const jsonRpcSchema = rpcResponse(z.unknown());

const amountSchema = z.union([z.number(), z.string()]).nullish();
const accountSchema = z.string().nullish();
const tokenTransferSchema = z.looseObject({
  fromUserAccount: accountSchema,
  toUserAccount: accountSchema,
  mint: z.string().nullish(),
  tokenAmount: amountSchema,
});
const nativeTransferSchema = z.looseObject({
  fromUserAccount: accountSchema,
  toUserAccount: accountSchema,
  amount: amountSchema,
});
const tokenSideSchema = z.looseObject({
  userAccount: accountSchema,
  mint: z.string().nullish(),
  rawTokenAmount: z
    .looseObject({
      tokenAmount: amountSchema,
      decimals: z.union([z.number(), z.string()]).nullish(),
    })
    .nullish(),
});
const nativeSideSchema = z
  .looseObject({ account: accountSchema, amount: amountSchema })
  .nullish();
const heliusTxSchema = z.looseObject({
  signature: z.string().nullish(),
  type: z.string().nullish(),
  timestamp: z.number().nullish(),
  source: z.string().nullish(),
  tokenTransfers: z.array(tokenTransferSchema).nullish(),
  nativeTransfers: z.array(nativeTransferSchema).nullish(),
  events: z
    .looseObject({
      swap: z
        .looseObject({
          nativeInput: nativeSideSchema,
          nativeOutput: nativeSideSchema,
          tokenInputs: z.array(tokenSideSchema).nullish(),
          tokenOutputs: z.array(tokenSideSchema).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const heliusTxPageSchema = z.union([
  z.array(heliusTxSchema),
  z.looseObject({ error: z.union([z.string(), rpcErrorSchema]) }),
]);

const tokenAccountsSchema = rpcResponse(
  z.looseObject({
    value: z.array(z.looseObject({ pubkey: z.string().nullish() })),
  }),
);

type TxProvider = {
  name: Vendor;
  gate: Limiter;
  pageUrl: (wallet: string, before: string | null) => string | null;
};

const PROVIDERS: TxProvider[] = [
  {
    name: "helius",
    gate: heliusGate,
    pageUrl: (wallet, before) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) return null;
      return (
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
        `?api-key=${apiKey}&limit=${PAGE_SIZE}` +
        (before ? `&before=${before}` : "")
      );
    },
  },
  {
    name: "triton",
    gate: tritonGate,
    pageUrl: (wallet, before) => {
      const base = process.env.TRITON_API_URL;
      if (!base) return null;
      return (
        `${base.replace(/\/$/, "")}/v0/addresses/${wallet}/transactions` +
        `?limit=${PAGE_SIZE}` +
        (before ? `&before=${before}` : "")
      );
    },
  },
];

export function isAuthError(code: number | undefined, msg: string): boolean {
  return code === -32401 || /invalid api key|unauthorized|forbidden/i.test(msg);
}

async function fetchFromProvider(
  provider: TxProvider,
  wallet: string,
  maxPages: number,
): Promise<TxFetchResult> {
  const all: HeliusTx[] = [];
  let before: string | null = null;
  let truncated = true;
  for (let i = 0; i < maxPages; i++) {
    const url = provider.pageUrl(wallet, before);
    if (!url) {
      throw new ProviderAuthError({
        vendor: provider.name,
        path: "env",
        message: `${provider.name} is not configured`,
      });
    }
    const page = await fetchJSON(url, {
      vendor: provider.name,
      schema: heliusTxPageSchema,
      gate: provider.gate,
    });
    if (!Array.isArray(page)) {
      const path = new URL(url).pathname;
      const err = page.error;
      const code =
        typeof err === "string" ? undefined : (err.code ?? undefined);
      const msg =
        typeof err === "string" ? err : err.message || JSON.stringify(err);
      if (isAuthError(code, msg)) {
        throw new ProviderAuthError({
          vendor: provider.name,
          path,
          message: `${provider.name}: ${msg}`,
        });
      }
      throw new VendorError({
        vendor: provider.name,
        kind: "api",
        path,
        message: `${provider.name} API error for ${wallet.slice(0, 4)}…: ${msg}`,
      });
    }
    if (page.length === 0) {
      truncated = false;
      break;
    }
    all.push(...(page as HeliusTx[]));
    if (page.length < PAGE_SIZE) {
      truncated = false;
      break;
    }
    before = page[page.length - 1]?.signature ?? null;
    if (!before) break;
  }
  return { txs: all, truncated };
}

async function fetchForAddress(
  address: string,
  maxPages: number,
): Promise<TxFetchResult> {
  const configured = PROVIDERS.filter((p) => p.pageUrl(address, null) !== null);
  if (configured.length === 0) {
    throw new ProviderAuthError({
      vendor: "helius",
      path: "env",
      message:
        "No transaction provider configured (set HELIUS_API_KEY or TRITON_API_URL)",
    });
  }

  const failures: unknown[] = [];
  for (const provider of configured) {
    try {
      return await fetchFromProvider(provider, address, maxPages);
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length === 1) throw failures[0];
  const summary = failures.map(describeError).join("; ");
  const first = failures[0];
  if (failures.every((e) => e instanceof ProviderAuthError)) {
    throw new ProviderAuthError({
      vendor: configured[0].name,
      path: "/v0/addresses",
      message: summary,
      status: first instanceof ProviderAuthError ? first.status : undefined,
    });
  }
  throw new VendorError({
    vendor: configured[0].name,
    kind: "api",
    path: "/v0/addresses",
    message: `All transaction providers failed: ${summary}`,
  });
}

async function getTokenAccounts(wallet: string): Promise<string[]> {
  if (!process.env.HELIUS_API_KEY) return [];
  const url = heliusRpcUrl();
  const out: string[] = [];
  for (const programId of TOKEN_PROGRAM_IDS) {
    const resp = await fetchJSON(url, {
      vendor: "helius",
      schema: tokenAccountsSchema,
      gate: heliusGate,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [wallet, { programId }, { encoding: "jsonParsed" }],
        }),
      },
    });
    if (resp.error) {
      const msg = resp.error.message || JSON.stringify(resp.error);
      if (isAuthError(resp.error.code ?? undefined, msg)) {
        throw new ProviderAuthError({
          vendor: "helius",
          path: "getTokenAccountsByOwner",
          message: `helius rpc: ${msg}`,
        });
      }
      throw new VendorError({
        vendor: "helius",
        kind: "api",
        path: "getTokenAccountsByOwner",
        message: `helius rpc getTokenAccountsByOwner failed for ${wallet.slice(0, 4)}…: ${msg}`,
      });
    }
    if (!resp.result) {
      throw new VendorError({
        vendor: "helius",
        kind: "shape",
        path: "getTokenAccountsByOwner",
        message: `helius rpc getTokenAccountsByOwner returned no result for ${wallet.slice(0, 4)}…`,
      });
    }
    for (const v of resp.result.value) {
      if (v.pubkey) out.push(v.pubkey);
    }
  }
  return out;
}

function fetchAddressesBounded(
  addresses: string[],
  maxPages: number,
): Promise<TxFetchResult[]> {
  return mapLimit(addresses, ACCOUNT_FETCH_CONCURRENCY, (address) =>
    fetchForAddress(address, maxPages),
  );
}

export function fetchTransactions(
  wallet: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<TxFetchResult> {
  return txCache.getOrFetch(wallet, () =>
    fetchTransactionsUncached(wallet, maxPages),
  );
}

async function fetchTransactionsUncached(
  wallet: string,
  maxPages: number,
): Promise<TxFetchResult> {
  const owner = await fetchForAddress(wallet, maxPages);

  const accountsEnumerable = Boolean(process.env.HELIUS_API_KEY);
  const tokenAccounts = await getTokenAccounts(wallet);
  const capped = tokenAccounts.length > MAX_TOKEN_ACCOUNTS;
  const accountResults = await fetchAddressesBounded(
    tokenAccounts.slice(0, MAX_TOKEN_ACCOUNTS),
    maxPages,
  );

  const merged = new Map<string, HeliusTx>();
  const unsigned: HeliusTx[] = [];
  for (const tx of [owner, ...accountResults].flatMap((r) => r.txs)) {
    if (tx.signature) {
      if (!merged.has(tx.signature)) merged.set(tx.signature, tx);
    } else {
      unsigned.push(tx);
    }
  }
  const txs = [...merged.values(), ...unsigned].sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
  );

  return {
    txs,
    truncated:
      owner.truncated ||
      capped ||
      !accountsEnumerable ||
      accountResults.some((r) => r.truncated),
  };
}
