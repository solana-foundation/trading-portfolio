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
