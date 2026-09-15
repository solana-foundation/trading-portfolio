import { NextResponse } from "next/server";
import { z } from "zod";
import { ProviderAuthError } from "@/lib/portfolio/helius";
import {
  getAggregateTradePnL,
  getPortfolioHoldings,
  tradeSortKey,
} from "@/lib/portfolio/pnl";
import { parseWalletsBody } from "@/lib/portfolio/request";
import type { TradeHistoryRow } from "@/lib/portfolio/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

type Cursor = { ts: number; key: string };

function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const ts = Number(raw.slice(0, sep));
  if (!Number.isFinite(ts)) return null;
  return { ts, key: raw.slice(sep + 1) };
}

function afterCursor(t: TradeHistoryRow, c: Cursor): boolean {
  const ts = t.ts || 0;
  if (ts !== c.ts) return ts < c.ts;
  return tradeSortKey(t).localeCompare(c.key) > 0;
}

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request, {
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().max(400).optional(),
    mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const limit = (parsed.body.limit as number | undefined) ?? DEFAULT_LIMIT;
  const cursor = parseCursor(parsed.body.cursor as string | undefined);
  const mint = parsed.body.mint as string | undefined;

  try {
    const holdings = await getPortfolioHoldings(parsed.wallets);
    const netWorth = holdings.reduce((s, h) => s + h.totalValue, 0);
    const result = await getAggregateTradePnL(parsed.wallets, holdings, netWorth);

    let trades = result.tradeHistory;
    if (mint) trades = trades.filter((t) => t.mint === mint);
    if (cursor) trades = trades.filter((t) => afterCursor(t, cursor));
    const page = trades.slice(0, limit);
    const last = page[page.length - 1];

    return NextResponse.json({
      trades: page,
      total: trades.length,
      nextCursor:
        page.length < trades.length && last
          ? `${last.ts}|${tradeSortKey(last)}`
          : null,
    });
  } catch (e) {
    if (e instanceof ProviderAuthError) {
      console.error("portfolio: provider auth failed:", e.message);
      return NextResponse.json(
        { error: "Upstream data provider unavailable." },
        { status: 502 },
      );
    }
    console.error("portfolio: trades failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Failed to load trade history." },
      { status: 502 },
    );
  }
}
