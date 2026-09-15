import { getHoldings, getPriceSeries } from "@/lib/portfolio/birdeye";
import {
  DAY_SECONDS,
  floorDay,
  reconstructDailyBalances,
} from "@/lib/portfolio/daily-balances";
import { getPool } from "@/lib/portfolio/db";
import { SOL_MINT, STABLECOIN_MINTS } from "@/lib/portfolio/swaps";
import { fetchTransactions } from "@/lib/portfolio/tx-provider";

const STALE_AFTER_DAYS = 90;
const MAX_PRICED_MINTS = 25;

export type WalletSeriesMeta = {
  genesisDay: string | null;
  days: number;
  truncated: boolean;
  backfilledNow: boolean;
};

export type ValueHistoryResult = {
  series: Array<{ day: string; valueUsd: number }>;
  todayValueUsd: number;
  wallets: Record<string, WalletSeriesMeta>;
  partial: boolean;
  hasUnpricedDays: boolean;
};

function isoDay(day: number): string {
  return new Date(day * 1000).toISOString().slice(0, 10);
}

async function pricesFor(
  mints: string[],
  fromDay: number,
  toDay: number,
): Promise<Map<string, Map<number, number>>> {
  const pool = getPool();
  const result = new Map<string, Map<number, number>>();
  for (const mint of mints) {
    if (STABLECOIN_MINTS.has(mint)) {
      const flat = new Map<number, number>();
      for (let d = fromDay; d <= toDay; d += DAY_SECONDS) flat.set(d, 1);
      result.set(mint, flat);
      continue;
    }
    const cached = await pool.query(
      `SELECT extract(epoch FROM day)::bigint AS day_ts, price_usd
         FROM price_daily
        WHERE mint = $1 AND day BETWEEN to_timestamp($2)::date AND to_timestamp($3)::date`,
      [mint, fromDay, toDay],
    );
    const known = new Map<number, number>(
      cached.rows.map((r) => [Number(r.day_ts), Number(r.price_usd)]),
    );
    let missing = 0;
    for (let d = fromDay; d <= toDay; d += DAY_SECONDS) {
      if (!known.has(d)) missing++;
    }
    if (missing > 0) {
      const fetched = await getPriceSeries(mint, fromDay, toDay + DAY_SECONDS - 1);
      const values: string[] = [];
      const params: unknown[] = [mint];
      for (const [d, p] of fetched) {
        if (known.has(d)) continue;
        known.set(d, p);
        params.push(d, p);
        values.push(
          `($1, to_timestamp($${params.length - 1})::date, $${params.length})`,
        );
      }
      if (values.length > 0) {
        await pool.query(
          `INSERT INTO price_daily (mint, day, price_usd) VALUES ${values.join(",")}
           ON CONFLICT (mint, day) DO NOTHING`,
          params,
        );
      }
    }
    result.set(mint, known);
  }
  return result;
}

async function cleanupStale(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM wallet_value_daily
      WHERE wallet IN (
        SELECT wallet FROM wallet_sync
         WHERE last_accessed_at < now() - make_interval(days => $1))`,
    [STALE_AFTER_DAYS],
  );
  await pool.query(
    `DELETE FROM wallet_sync
      WHERE last_accessed_at < now() - make_interval(days => $1)`,
    [STALE_AFTER_DAYS],
  );
}

async function syncWallet(
  wallet: string,
  todayDay: number,
): Promise<{ meta: WalletSeriesMeta; unpriced: boolean; partial: boolean; todayValueUsd: number }> {
  const pool = getPool();
  const sync = await pool.query(
    `INSERT INTO wallet_sync (wallet) VALUES ($1)
     ON CONFLICT (wallet) DO UPDATE SET last_accessed_at = now()
     RETURNING backfilled, truncated`,
    [wallet],
  );
  const wasBackfilled: boolean = sync.rows[0].backfilled;

  const maxRow = await pool.query(
    `SELECT extract(epoch FROM max(day))::bigint AS max_day
       FROM wallet_value_daily WHERE wallet = $1`,
    [wallet],
  );
  const storedMaxDay: number | null = maxRow.rows[0].max_day
    ? Number(maxRow.rows[0].max_day)
    : null;

  const holdings = await getHoldings(wallet);
  const todayValueUsd = holdings.totalValue;
  const yesterday = todayDay - DAY_SECONDS;

  let unpriced = false;
  let partial = false;
  let truncated: boolean = sync.rows[0].truncated;
  let backfilledNow = false;

  const needsWork =
    !wasBackfilled || storedMaxDay === null || storedMaxDay < yesterday;

  if (needsWork) {
    const fetched = await fetchTransactions(wallet);
    truncated = fetched.truncated;
    const currentBalances = new Map<string, number>();
    for (const t of holdings.tokens) {
      if (t.balance > 0) currentBalances.set(t.address, t.balance);
    }
    let days = reconstructDailyBalances(
      wallet,
      currentBalances,
      fetched.txs,
      todayDay,
    );
    if (wasBackfilled && storedMaxDay !== null) {
      days = days.filter((d) => d.day > storedMaxDay);
    }
    if (days.length > 0) {
      const mintValue = new Map<string, number>();
      for (const t of holdings.tokens) mintValue.set(t.address, t.value);
      const allMints = new Set<string>();
      for (const d of days) for (const m of d.balances.keys()) allMints.add(m);
      const ranked = Array.from(allMints).sort(
        (a, b) => (mintValue.get(b) || 0) - (mintValue.get(a) || 0),
      );
      const priced = new Set(ranked.slice(0, MAX_PRICED_MINTS));
      priced.add(SOL_MINT);
      if (ranked.length > priced.size) partial = true;

      const fromDay = days[0].day;
      const toDay = days[days.length - 1].day;
      const prices = await pricesFor(Array.from(priced), fromDay, toDay);

      const values: string[] = [];
      const params: unknown[] = [wallet];
      for (const d of days) {
        let value = 0;
        for (const [mint, amount] of d.balances) {
          if (!priced.has(mint)) continue;
          const p = prices.get(mint)?.get(d.day);
          if (p === undefined) {
            unpriced = true;
            continue;
          }
          value += amount * p;
        }
        params.push(d.day, value);
        values.push(
          `($1, to_timestamp($${params.length - 1})::date, $${params.length})`,
        );
      }
      if (values.length > 0) {
        await pool.query(
          `INSERT INTO wallet_value_daily (wallet, day, value_usd)
           VALUES ${values.join(",")}
           ON CONFLICT (wallet, day) DO NOTHING`,
          params,
        );
      }
    }
    backfilledNow = !wasBackfilled;
    await pool.query(
      `UPDATE wallet_sync
          SET backfilled = true,
              truncated = $2,
              genesis_day = (SELECT min(day) FROM wallet_value_daily WHERE wallet = $1),
              updated_at = now()
        WHERE wallet = $1`,
      [wallet, truncated],
    );
  }

  const bounds = await pool.query(
    `SELECT extract(epoch FROM min(day))::bigint AS min_day, count(*)::int AS days
       FROM wallet_value_daily WHERE wallet = $1`,
    [wallet],
  );
  return {
    meta: {
      genesisDay: bounds.rows[0].min_day
        ? isoDay(Number(bounds.rows[0].min_day))
        : null,
      days: bounds.rows[0].days,
      truncated,
      backfilledNow,
    },
    unpriced,
    partial,
    todayValueUsd,
  };
}

export async function getValueHistory(
  wallets: string[],
): Promise<ValueHistoryResult> {
  const todayDay = floorDay(Math.floor(Date.now() / 1000));
  const pool = getPool();

  const metas: Record<string, WalletSeriesMeta> = {};
  let partial = false;
  let hasUnpricedDays = false;
  let todayValueUsd = 0;
  for (const wallet of wallets) {
    const r = await syncWallet(wallet, todayDay);
    metas[wallet] = r.meta;
    partial = partial || r.partial || r.meta.truncated;
    hasUnpricedDays = hasUnpricedDays || r.unpriced;
    todayValueUsd += r.todayValueUsd;
  }

  const summed = await pool.query(
    `SELECT extract(epoch FROM day)::bigint AS day_ts, sum(value_usd) AS value
       FROM wallet_value_daily
      WHERE wallet = ANY($1)
      GROUP BY day ORDER BY day`,
    [wallets],
  );
  const series = summed.rows.map((r) => ({
    day: isoDay(Number(r.day_ts)),
    valueUsd: Number(r.value),
  }));

  void cleanupStale().catch((e) =>
    console.error("portfolio: stale cleanup failed:", (e as Error).message),
  );

  return { series, todayValueUsd, wallets: metas, partial, hasUnpricedDays };
}
