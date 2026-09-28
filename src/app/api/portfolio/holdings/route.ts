import { NextResponse } from "next/server";
import { classifyHolding } from "@/lib/portfolio/birdeye";
import { getPortfolioHoldings } from "@/lib/portfolio/pnl";
import { parseWalletsBody } from "@/lib/portfolio/request";
import type { TokenHolding } from "@/lib/portfolio/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
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
          if (!existing.price && t.price) existing.price = t.price;
          if (!existing.symbol) existing.symbol = t.symbol;
          if (!existing.icon) existing.icon = t.icon;
        }
      }
    }
    const mergedTokens: TokenHolding[] = Array.from(merged.values())
      .map(({ hidden: _prior, ...rest }) => {
        const token = { ...rest, value: rest.balance * rest.price };
        const hidden = classifyHolding(token);
        return hidden ? { ...token, hidden } : token;
      })
      .sort((a, b) => b.value - a.value);
    const mergedVisible = mergedTokens.filter((t) => !t.hidden);

    return NextResponse.json({
      perWallet: Object.fromEntries(
        parsed.wallets.map((w, i) => [
          w,
          holdings[i] && {
            tokens: holdings[i].tokens,
            totalValue: holdings[i].totalValue,
            unpricedCount: holdings[i].unpricedCount,
          },
        ]),
      ),
      merged: {
        tokens: mergedTokens,
        totalValue: mergedVisible.reduce((s, t) => s + t.value, 0),
        unpricedCount: new Set(holdings.flatMap((h) => h?.unpricedMints || []))
          .size,
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
