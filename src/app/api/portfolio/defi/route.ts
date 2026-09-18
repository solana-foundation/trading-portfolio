import { NextResponse } from "next/server";
import { getDefiPositions } from "@/lib/portfolio/defi";
import { parseWalletsBody } from "@/lib/portfolio/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const result = await getDefiPositions(parsed.wallets);
    return NextResponse.json(result);
  } catch (e) {
    console.error("portfolio: defi failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Failed to load DeFi positions." },
      { status: 502 },
    );
  }
}
