# trading-portfolio

Open-source Solana portfolio API: full-history volume, PnL, and holdings for any wallet, computed by a cost-basis engine over provider archival data. **No indexing infrastructure** — history and balances come from archival providers (Helius), historical prices and metadata from Birdeye; the service owns the interpretation layer, never the storage layer.

This powers the Frontier Traders portfolio experience, and anyone can self-host it on their own provider API keys.

## API

All aggregation endpoints are stateless: wallet list in, merged result out, nothing stored. A single wallet is a portfolio of one. Requests are `POST` with a JSON body; 1–20 base58 wallet addresses per request.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/portfolio/summary` | `{wallets[]}` | Net worth, invested, absolute return, XIRR (with SOL benchmark), per-wallet split |
| `POST /api/portfolio/holdings` | `{wallets[]}` | Per-wallet and merged-by-token balances with USD values |
| `POST /api/portfolio/pnl` | `{wallets[]}` | Per-asset cost basis, average cost, unrealized PnL, per wallet and across the group |
| `POST /api/portfolio/trades` | `{wallets[], limit?, cursor?, mint?}` | Priced trade history (swaps + external transfer-ins), stable-cursor paginated |
| `POST /api/portfolio/value-history` | `{wallets[]}` | Daily portfolio value series from Postgres: first request lazily backfills a wallet's full available history, later requests read the store, top up missing days, and compute today live. Per-wallet rows are write-once and shared; wallets untouched for 90 days are pruned. Requires `DATABASE_URL`; migrations in `db/migrations` (`db/apply.sh`) |

The hosted deployment is private: Cloud Run requires an IAM-authorized identity (`roles/run.invoker`), and callers send a Google-signed ID token with the service URL as audience (`Authorization: Bearer $(gcloud auth print-identity-token)` for ad-hoc use; internal services impersonate the `portfolio-invoker-prd` service account). Self-hosting from this repo has no such gate — bring your own keys and add your own auth.

## API reference

Common to every endpoint:

- `POST` with `Content-Type: application/json`.
- Body always includes `wallets`: array of 1–20 base58 Solana addresses; duplicates are deduplicated. Extra unknown fields are rejected where noted.
- Errors: `400 {"error": string}` for invalid input, `502 {"error": string}` when an upstream data provider fails (responses are never partial-as-complete — retry), `503` from `value-history` when no store is configured.
- Numbers are plain JSON numbers in USD unless stated; timestamps `ts` are unix seconds; `day` is `YYYY-MM-DD` (UTC).
- Degradation is always surfaced, never guessed: watch `hasUnpriced`, `historyTruncated`, `partial`, `hasUnpricedDays`.

### `POST /api/portfolio/summary`

Request: `{"wallets": ["..."]}`

```jsonc
{
  "netWorthUsd": 118886.63,          // sum of all held token values, basis or not
  "summary": {
    "currentValue": 118886.63,
    "investedTotal": 85893.79,       // sum of covered cost bases
    "investedGross": 103518.33,      // gross external inflows (cashflow-based)
    "realizedReceipts": 0.94,        // gross external outflows
    "absoluteReturnUsd": 32991.52,   // currentValue - investedTotal
    "absoluteReturnPct": 38.41,      // null when investedTotal is 0
    "xirrPct": 24.1,                 // annualized, from dated external cashflows; null if underdetermined
    "benchmarkSolXirrPct": -69.11,   // same cashflows had they bought SOL
    "cashflowCount": 43
  },
  "totals": { "totalPnL": 0, "totalCostBasis": 0, "totalValue": 0 },
  "perWalletValue": { "<wallet>": 12345.67 },
  "solPriceUsd": 261.4,
  "walletsScanned": 8,
  "hasUnpriced": true,               // some events had no day-of price or ambiguous allocation
  "historyTruncated": false          // provider history or token-account coverage was capped
}
```

### `POST /api/portfolio/holdings`

Request: `{"wallets": ["..."]}`

```jsonc
{
  "perWallet": {
    "<wallet>": {
      "tokens": [
        { "address": "<mint>", "symbol": "SOL", "name": "Solana",
          "icon": "https://…", "balance": 1.5, "price": 261.4, "value": 392.1 }
      ],
      "totalValue": 392.1
    }
  },
  "merged": { "tokens": [ /* same shape, summed across wallets */ ], "totalValue": 392.1 }
}
```

Dust below $0.01 is dropped; `price: 0` means the vendor has no current price (value counts as 0 and the token is unpriced, not hidden).

### `POST /api/portfolio/pnl`

Request: `{"wallets": ["..."]}`

```jsonc
{
  "perWallet": {
    "<wallet>": [
      {
        "mint": "<mint>", "symbol": "ZEC",
        "currentAmount": 31.74, "currentPrice": 1186.07, "currentValue": 37647.46,
        "costBasis": 14869.13,        // covered portion only — never zero-cost dilution
        "avgCostPerToken": 468.5,
        "pnl": 22872.79,              // over the covered amount
        "pnlPercent": 153.8,
        "householdSpent": 14869.13, "householdBought": 31.74, "householdHeld": 31.74,
        "txCount": 12,
        "costSource": "swap+transfer",          // where basis came from
        "attribution": "wallet" | "household"   // own buys vs group-level basis
      }
    ]
  },
  "mintCosts": [ { "mint": "<mint>", "symbol": "ZEC", "avgCostPerToken": 468.5 } ],
  "totals": { "totalPnL": 0, "totalCostBasis": 0, "totalValue": 0 },
  "summary": { /* same shape as /summary .summary */ },
  "tradeHistory": [ /* same rows as /trades, unpaginated */ ],
  "solPriceUsd": 261.4,
  "walletsScanned": 8,
  "hasUnpriced": true,
  "historyTruncated": false
}
```

Per-asset rows are basis-gated: a held token with no priceable acquisition
history gets no row (and raises `hasUnpriced`) instead of a guessed basis.
`netWorthUsd`/`summary.currentValue` still count every held token.

### `POST /api/portfolio/trades`

Request: `{"wallets": ["..."], "limit": 100, "cursor": "<opaque>", "mint": "<mint>"}` —
`limit` 1–500 (default 100), `cursor` from a previous `nextCursor`, `mint` filters to one token. All optional.

```jsonc
{
  "trades": [
    {
      "kind": "buy_swap" | "sell_swap" | "buy_transfer",
      "side": "buy" | "sell",
      "wallet": "<wallet>", "walletShort": "D1Br…zm2h",
      "mint": "<mint>", "symbol": "MON",
      "amount": 3938.53, "usd": 224.81,   // valued at the event day's price
      "ts": 1763998803,
      "signature": "<tx signature>",
      "source": "TITAN",                  // venue label, or "TRANSFER"
      "fromExternal": false,              // true for transfer-ins from outside the wallet group
      "fromAccount": "<sender>"           // transfer-ins only
    }
  ],
  "total": 126,
  "historyTruncated": false,
  "nextCursor": "1763998803|<sort-key>"   // null on the last page; pagination is stable-cursor, never offset
}
```

Events that cannot be valued at their event day are excluded from this list
entirely (and surfaced via `hasUnpriced` on `/pnl`), never shown at $0.

### `POST /api/portfolio/value-history`

Request: `{"wallets": ["..."]}`

```jsonc
{
  "series": [ { "day": "2025-11-24", "valueUsd": 51210.90 } ],  // summed across wallets, daily, back to earliest wallet genesis
  "todayValueUsd": 118986.31,       // live, not from the store
  "wallets": {
    "<wallet>": {
      "genesisDay": "2025-11-24",
      "days": 296, "vendorDays": 0,
      "incompleteDays": 296,        // days where some held mint had no day price
      "truncated": false,           // history coverage was capped for this wallet
      "backfilledNow": true         // this request built the wallet's series for the first time
    }
  },
  "partial": false,
  "hasUnpricedDays": true
}
```

First request for a new wallet synchronously builds its full daily series
(can take 1–2 minutes); later requests top up recent days from the store.

## Methodology

- **Cost basis**: weighted-average cost per (wallet group, mint), derived from on-chain swap history. Transfer-ins are valued at the historical price on the day of receipt.
- **Cross-wallet attribution**: when a token is held in one wallet but was bought in another wallet of the same request group, cost basis follows the token (`attribution: "household"`).
- **Pricing**: swap cash legs (stables, SOL) are valued at the trade day's historical price. Swap sides with multiple distinct token mints are reported as unpriced rather than misallocated.
- **Returns**: invested, absolute return, and annualized XIRR from dated external cashflows, benchmarked against holding SOL.
- Responses carry `hasUnpriced` so consumers can display confidence honestly.

## Running

```bash
pnpm install
cp .env.example .env   # add HELIUS_API_KEY and BIRDEYE_API_KEY
pnpm dev
```

Provider keys stay server-side; never expose them to a browser.

```bash
pnpm typecheck
pnpm test
```

## License

Apache-2.0
