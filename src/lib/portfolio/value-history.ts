import type { PoolClient } from "pg";
import {
  getHoldings,
  getNetWorthHistory,
  getPriceSeries,
  getRawBalances,
} from "@/lib/portfolio/birdeye";
import {
  DAY_SECONDS,
  floorDay,
  reconstructDailyBalances,
} from "@/lib/portfolio/daily-balances";
import { getPool } from "@/lib/portfolio/db";
import { SOL_MINT, STABLECOIN_MINTS } from "@/lib/portfolio/swaps";
import { fetchTransactions } from "@/lib/portfolio/tx-provider";

const STALE_AFTER_DAYS = 90;
const MAX_PRICED_MINTS = 1000;
const PRICE_FETCH_CONCURRENCY = 8;
const VENDOR_WINDOW_DAYS = 90;

export type WalletSeriesMeta = {
  genesisDay: string | null;
  days: number;
  vendorDays: number;
  incompleteDays: number;
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
  client: PoolClient,
  mints: string[],
  fromDay: number,
  toDay: number,
): Promise<Map<string, Map<number, number>>> {
  const result = new Map<string, Map<number, number>>();
  const lookup: string[] = [];
  for (const mint of mints) {
    if (STABLECOIN_MINTS.has(mint)) {
      const flat = new Map<number, number>();
      for (let d = fromDay; d <= toDay; d += DAY_SECONDS) flat.set(d, 1);
      result.set(mint, flat);
    } else {
      result.set(mint, new Map<number, number>());
      lookup.push(mint);
    }
  }
  if (lookup.length > 0) {
    const cached = await client.query(
      `SELECT mint, extract(epoch FROM day)::bigint AS day_ts, price_usd
         FROM price_daily
        WHERE mint = ANY($1) AND day BETWEEN to_timestamp($2)::date AND to_timestamp($3)::date`,
      [lookup, fromDay, toDay],
    );
    for (const r of cached.rows) {
      result.get(r.mint as string)?.set(Number(r.day_ts), Number(r.price_usd));
    }
  }
  const needFetch: string[] = [];
  for (const mint of lookup) {
    const known = result.get(mint)!;
    for (let d = fromDay; d <= toDay; d += DAY_SECONDS) {
      if (!known.has(d)) {
        needFetch.push(mint);
        break;
      }
    }
  }

  const fetchedSeries = new Map<string, Awaited<ReturnType<typeof getPriceSeries>>>();
  let next = 0;
  async function fetchWorker(): Promise<void> {
    while (next < needFetch.length) {
      const mint = needFetch[next++];
      fetchedSeries.set(
        mint,
        await getPriceSeries(mint, fromDay, toDay + DAY_SECONDS - 1),
      );
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(PRICE_FETCH_CONCURRENCY, needFetch.length) },
      () => fetchWorker(),
    ),
  );

  const newRows: Array<[string, number, number]> = [];
  for (const mint of needFetch) {
    const known = result.get(mint);
    const fetched = fetchedSeries.get(mint);
    if (!known || !fetched) continue;
    for (const [d, p] of fetched) {
      if (known.has(d) || d < fromDay || d > toDay) continue;
      known.set(d, p);
      newRows.push([mint, d, p]);
    }
  }
  const INSERT_CHUNK = 5000;
  for (let start = 0; start < newRows.length; start += INSERT_CHUNK) {
    const chunk = newRows.slice(start, start + INSERT_CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const [mint, d, p] of chunk) {
      params.push(mint, d, p);
      values.push(
        `($${params.length - 2}, to_timestamp($${params.length - 1})::date, $${params.length})`,
      );
    }
    await client.query(
      `INSERT INTO price_daily (mint, day, price_usd) VALUES ${values.join(",")}
       ON CONFLICT (mint, day) DO NOTHING`,
      params,
    );
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

type SyncOutcome = {
  meta: WalletSeriesMeta;
  partial: boolean;
  todayValueUsd: number;
};

async function syncWalletLocked(
  client: PoolClient,
  wallet: string,
  todayDay: number,
): Promise<SyncOutcome> {
  const sync = await client.query(
    `INSERT INTO wallet_sync (wallet) VALUES ($1)
     ON CONFLICT (wallet) DO UPDATE SET last_accessed_at = now()
     RETURNING backfilled, truncated`,
    [wallet],
  );
  const wasBackfilled: boolean = sync.rows[0].backfilled;

  const state = await client.query(
    `SELECT extract(epoch FROM max(day))::bigint AS max_day,
            coalesce(array_agg(extract(epoch FROM day)::bigint)
              FILTER (WHERE NOT complete), '{}') AS incomplete_days
       FROM wallet_value_daily WHERE wallet = $1`,
    [wallet],
  );
  const storedMaxDay: number | null = state.rows[0].max_day
    ? Number(state.rows[0].max_day)
    : null;
  const incompleteDaySet = new Set<number>(
    (state.rows[0].incomplete_days as unknown[]).map(Number),
  );

  const holdings = await getHoldings(wallet);
  const todayValueUsd = holdings.totalValue;
  const yesterday = todayDay - DAY_SECONDS;

  let partial = false;
  let truncated: boolean = sync.rows[0].truncated;
  let backfilledNow = false;

  const needsWork =
    !wasBackfilled ||
    storedMaxDay === null ||
    storedMaxDay < yesterday ||
    incompleteDaySet.size > 0;

  if (needsWork) {
    const fetched = await fetchTransactions(wallet);
    truncated = fetched.truncated;
    const currentBalances = await getRawBalances(wallet);
    let days = reconstructDailyBalances(
      wallet,
      currentBalances,
      fetched.txs,
      todayDay,
    );
    if (wasBackfilled && storedMaxDay !== null) {
      days = days.filter(
        (d) => d.day > storedMaxDay || incompleteDaySet.has(d.day),
      );
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
      const prices = await pricesFor(client, Array.from(priced), fromDay, toDay);

      const values: string[] = [];
      const params: unknown[] = [wallet];
      for (const d of days) {
        let value = 0;
        let complete = true;
        for (const [mint, amount] of d.balances) {
          if (!priced.has(mint)) continue;
          const p = prices.get(mint)?.get(d.day);
          if (p === undefined) {
            complete = false;
            continue;
          }
          value += amount * p;
        }
        params.push(d.day, value, complete);
        values.push(
          `($1, to_timestamp($${params.length - 2})::date, $${params.length - 1}, 'engine', $${params.length})`,
        );
      }
      if (values.length > 0) {
        await client.query(
          `INSERT INTO wallet_value_daily (wallet, day, value_usd, source, complete)
           VALUES ${values.join(",")}
           ON CONFLICT (wallet, day) DO UPDATE
             SET value_usd = EXCLUDED.value_usd,
                 source = EXCLUDED.source,
                 complete = EXCLUDED.complete
           WHERE NOT wallet_value_daily.complete`,
          params,
        );
      }
    }
    backfilledNow = !wasBackfilled;
    await client.query(
      `UPDATE wallet_sync
          SET backfilled = true,
              truncated = $2,
              genesis_day = (SELECT min(day) FROM wallet_value_daily WHERE wallet = $1),
              updated_at = now()
        WHERE wallet = $1`,
      [wallet, truncated],
    );
  }

  if (truncated) {
    const vendorState = await client.query(
      `SELECT extract(epoch FROM min(day) FILTER (WHERE source = 'engine'))::bigint AS engine_min,
              count(*) FILTER (WHERE source = 'birdeye')::int AS vendor_days
         FROM wallet_value_daily WHERE wallet = $1`,
      [wallet],
    );
    const engineGenesis: number | null = vendorState.rows[0].engine_min
      ? Number(vendorState.rows[0].engine_min)
      : null;
    if (engineGenesis !== null) {
      const windowStart = todayDay - VENDOR_WINDOW_DAYS * DAY_SECONDS;
      const expectedVendorDays = Math.max(
        0,
        Math.floor((engineGenesis - windowStart) / DAY_SECONDS),
      );
      if (Number(vendorState.rows[0].vendor_days) < expectedVendorDays) {
        const vendor = await getNetWorthHistory(wallet);
        const values: string[] = [];
        const params: unknown[] = [wallet];
        for (const [day, value] of vendor) {
          if (day >= engineGenesis) continue;
          params.push(day, value);
          values.push(
            `($1, to_timestamp($${params.length - 1})::date, $${params.length}, 'birdeye', true)`,
          );
        }
        if (values.length > 0) {
          await client.query(
            `INSERT INTO wallet_value_daily (wallet, day, value_usd, source, complete)
             VALUES ${values.join(",")}
             ON CONFLICT (wallet, day) DO NOTHING`,
            params,
          );
          await client.query(
            `UPDATE wallet_sync
                SET genesis_day = (SELECT min(day) FROM wallet_value_daily WHERE wallet = $1),
                    updated_at = now()
              WHERE wallet = $1`,
            [wallet],
          );
        }
      }
    }
  }

  const bounds = await client.query(
    `SELECT extract(epoch FROM min(day))::bigint AS min_day,
            count(*)::int AS days,
            count(*) FILTER (WHERE source = 'birdeye')::int AS vendor_days,
            count(*) FILTER (WHERE NOT complete)::int AS incomplete_days
       FROM wallet_value_daily WHERE wallet = $1`,
    [wallet],
  );
  return {
    meta: {
      genesisDay: bounds.rows[0].min_day
        ? isoDay(Number(bounds.rows[0].min_day))
        : null,
      days: bounds.rows[0].days,
      vendorDays: bounds.rows[0].vendor_days,
      incompleteDays: bounds.rows[0].incomplete_days,
      truncated,
      backfilledNow,
    },
    partial,
    todayValueUsd,
  };
}

async function syncWallet(
  wallet: string,
  todayDay: number,
): Promise<SyncOutcome> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [wallet]);
    try {
      return await syncWalletLocked(client, wallet, todayDay);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [wallet])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
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
    hasUnpricedDays = hasUnpricedDays || r.meta.incompleteDays > 0;
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
