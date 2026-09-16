import { NextResponse } from "next/server";
import { getPortfolioHoldings } from "@/lib/portfolio/pnl";
import { parseWalletsBody } from "@/lib/portfolio/request";
import type { TokenHolding } from "@/lib/portfolio/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const holdings = await getPortfolioHoldings(parsed.wallets);

    const merged = new Map<string, TokenHolding>();
    for (const h of holdings) {
      for (const t of h.tokens) {
        const existing = merged.get(t.address);
        if (!existing) {
          merged.set(t.address, { ...t });
        } else {
          existing.balance += t.balance;
          existing.value += t.value;
          if (!existing.symbol) existing.symbol = t.symbol;
          if (!existing.icon) existing.icon = t.icon;
        }
      }
    }
    const mergedTokens = Array.from(merged.values()).sort(
      (a, b) => b.value - a.value,
    );

    return NextResponse.json({
      perWallet: Object.fromEntries(
        parsed.wallets.map((w, i) => [w, holdings[i]]),
      ),
      merged: {
        tokens: mergedTokens,
        totalValue: mergedTokens.reduce((s, t) => s + t.value, 0),
        unpricedCount: holdings.reduce((s, h) => s + (h?.unpricedCount || 0), 0),
      },
    });
  } catch (e) {
    console.error("portfolio: holdings failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Failed to load holdings." },
      { status: 502 },
    );
  }
}
