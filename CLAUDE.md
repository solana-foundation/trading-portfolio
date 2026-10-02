# trading-portfolio

Open-source Solana portfolio API. Next.js App Router (API routes only, no UI), TypeScript strict, pnpm. Public repo — never commit secrets, keys, or Frontier-internal references; Frontier's integration lives privately in trading-solana-com and calls this API.

## Commands

- `pnpm dev` — dev server
- `pnpm typecheck` — tsc strict, must be clean before commit
- `pnpm lint` — biome check (format + lint), must be clean before commit; `pnpm format` auto-fixes
- `pnpm test` — vitest (`tests/*.test.ts`, `@/` alias)
- `pnpm build` — production build

## Architecture (see Frontier Portfolio design doc for full context)

- **No indexing infrastructure.** Data store + live fetch: history/balances from Helius archival, historical prices/metadata from Birdeye. We own interpretation, never storage. If vendor parsing of a venue is wrong, the fix is a venue-specific parser over raw archival data — not an indexer.
- **Stateless aggregation**: wallet list in (1–20, base58, zod-validated), merged result out, nothing stored. A single wallet is a portfolio of one. Wallet groupings must never be persisted server-side.
- `src/lib/portfolio/` — engine (pure where possible): `swaps.ts` (Helius tx parsing, swap synthesis), `pnl.ts` (weighted-average cost basis, household attribution, XIRR), `xirr.ts`, vendor clients (`tx-provider.ts`, `birdeye.ts`, `defi.ts`), `fetch-json.ts` (the only place `fetch` is called: per-attempt timeout, jittered retry on 429/5xx/network/timeout and on a 2xx body that is not JSON (an edge or proxy error page), `Retry-After`, a per-call budget that also bounds time spent queued for a vendor slot, and a required zod schema per response; a schema mismatch is never retried), `errors.ts` (`VendorError` with vendor/kind/status/path; `ProviderAuthError`; `mapError` for routes), `concurrency.ts` (`mapLimit` for per-call fan-out, which stops claiming items after the first failure but does not cancel in-flight ones; `createLimiter` for process-wide per-vendor caps: Birdeye has two by design, 8 slots for the price and metadata lookups that fan out by the hundred and 40 for wallet token lists, which number at most 20 per request; Helius and Triton have 8 each), `cache.ts` (in-process TTL, in-flight dedupe via `getOrFetch`, per-entry TTL), `deadline.ts` (`requestBudget`: one time budget per request shared across a route's awaits, failing with a typed 502 before the platform's `maxDuration`; value-history carries its own internal deadline).
- `src/app/api/portfolio/*/route.ts` — thin handlers: validate, wrap engine calls in the request budget, map errors. `runtime = "nodejs"`, `force-dynamic`.

## Cardinal rules

- **Wrong PnL is worse than no PnL.** Value at the historical price of the event's day, never today's price for past events. Anything unpriceable is surfaced (`hasUnpriced`, unpriced counters) — never guessed, never silently dropped from totals.
- **Vendor errors fail loud.** A provider failure returns 502; never cache or return partial history as complete. This includes Birdeye price lookups, which have exactly three outcomes: `success: true` without a value is a vendor-asserted miss, cached as `null` for 30 minutes and surfaced as `hasUnpriced`; `success: false` or a body without the `success` flag is a vendor refusal, `null` for that call only, uncached and logged; a transport, 429, or 5xx failure after retries, or a `success: true` body whose value has the wrong type, is a 502. Token metadata (symbol, icon) follows the same three outcomes but is cosmetic, so every non-auth, non-config failure degrades to an uncached `null`. `/defi` may degrade one source per wallet to `partial: true` plus a `failed` entry, and a degraded wallet is never cached.
- **Totals must be internally consistent**: `summary.currentValue` counts every held token, basis or not; only per-asset PnL rows are basis-gated.
- **Pagination is stable-cursor** (`ts|signature|kind|wallet|mint` over the deterministic sort), never offset — the underlying list rebuilds on cache expiry.
- **API keys are server-side only** (`HELIUS_API_KEY`, `BIRDEYE_API_KEY` via env). Nothing here may ever run in a browser context.
- Zero code comments by convention. 2-space indent, double quotes, named exports.

## Style

- No new dependencies without strong cause — stdlib and platform first (the TTL cache is under 50 lines on purpose; zod and pg are the only runtime deps beyond Next).
- Tests colocated in `tests/`, pure-function coverage for engine logic; no network in tests. Vendor modules are tested by stubbing `globalThis.fetch` with `vi.stubGlobal` and driving retries with fake timers; `AbortSignal.timeout` uses internal timers that fake timers do not patch, so tests drive outcomes through the mocked response, never through the attempt timeout.
