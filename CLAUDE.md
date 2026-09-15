# trading-portfolio

Open-source Solana portfolio API. Next.js App Router (API routes only, no UI), TypeScript strict, pnpm. Public repo — never commit secrets, keys, or Frontier-internal references; Frontier's integration lives privately in trading-solana-com and calls this API.

## Commands

- `pnpm dev` — dev server
- `pnpm typecheck` — tsc strict, must be clean before commit
- `pnpm test` — vitest (`tests/*.test.ts`, `@/` alias)
- `pnpm build` — production build

## Architecture (see Frontier Portfolio design doc for full context)

- **No indexing infrastructure.** Data store + live fetch: history/balances from Helius archival, historical prices/metadata from Birdeye. We own interpretation, never storage. If vendor parsing of a venue is wrong, the fix is a venue-specific parser over raw archival data — not an indexer.
- **Stateless aggregation**: wallet list in (1–20, base58, zod-validated), merged result out, nothing stored. A single wallet is a portfolio of one. Wallet groupings must never be persisted server-side.
- `src/lib/portfolio/` — engine (pure where possible): `swaps.ts` (Helius tx parsing, swap synthesis), `pnl.ts` (weighted-average cost basis, household attribution, XIRR), `xirr.ts`, vendor clients (`helius.ts`, `birdeye.ts`), `cache.ts` (in-process TTL only).
- `src/app/api/portfolio/*/route.ts` — thin handlers: validate, call engine, map errors. `runtime = "nodejs"`, `force-dynamic`.

## Cardinal rules

- **Wrong PnL is worse than no PnL.** Value at the historical price of the event's day, never today's price for past events. Anything unpriceable is surfaced (`hasUnpriced`, unpriced counters) — never guessed, never silently dropped from totals.
- **Vendor errors fail loud.** A provider failure returns 502; never cache or return partial history as complete.
- **Totals must be internally consistent**: `summary.currentValue` counts every held token, basis or not; only per-asset PnL rows are basis-gated.
- **Pagination is stable-cursor** (`ts|signature|kind|wallet|mint` over the deterministic sort), never offset — the underlying list rebuilds on cache expiry.
- **API keys are server-side only** (`HELIUS_API_KEY`, `BIRDEYE_API_KEY` via env). Nothing here may ever run in a browser context.
- Zero code comments by convention. 2-space indent, double quotes, named exports.

## Style

- No new dependencies without strong cause — stdlib and platform first (the TTL cache is 25 lines on purpose; zod is the only runtime dep beyond Next).
- Tests colocated in `tests/`, pure-function coverage for engine logic; no network in tests.
