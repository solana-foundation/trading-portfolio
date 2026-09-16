"use client";

import { useEffect, useMemo, useState } from "react";
import {
  UnifiedWalletButton,
  UnifiedWalletProvider,
  useWallet,
} from "@jup-ag/wallet-adapter";
import { MAX_WALLETS_PER_REQUEST } from "@/lib/portfolio/request";
import type {
  TokenHolding,
  TradePnLResult,
} from "@/lib/portfolio/types";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STORAGE_KEY = "mockup-wallets";
const PORTFOLIOS_KEY = "mockup-portfolios";
const ACTIVE_PORTFOLIO_KEY = "mockup-active-portfolio";

type Portfolio = { id: string; name: string; wallets: string[] };

type HoldingsResponse = {
  merged: { tokens: TokenHolding[]; totalValue: number };
};

type ValueHistoryResponse = {
  series: Array<{ day: string; valueUsd: number }>;
  todayValueUsd: number;
  partial: boolean;
  hasUnpricedDays: boolean;
  wallets: Record<
    string,
    { genesisDay: string | null; backfilledNow: boolean; truncated: boolean }
  >;
};

type FetchState<T> = { data: T | null; loading: boolean; error: string | null };

function usePost<T>(path: string, wallets: string[]): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({
    data: null,
    loading: false,
    error: null,
  });
  const key = wallets.join(",");
  useEffect(() => {
    if (!key) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const ctrl = new AbortController();
    setState({ data: null, loading: true, error: null });
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallets: key.split(",") }),
      signal: ctrl.signal,
    })
      .then(async (r) => {
        const body = (await r.json()) as T & { error?: string };
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        setState({ data: body, loading: false, error: null });
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) {
          setState({ data: null, loading: false, error: (e as Error).message });
        }
      });
    return () => ctrl.abort();
  }, [path, key]);
  return state;
}

function useTrackedWallets() {
  const [wallets, setWallets] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setWallets(
            parsed.filter(
              (w): w is string => typeof w === "string" && BASE58_RE.test(w),
            ),
          );
        }
      }
    } catch {}
  }, []);
  const save = (ws: string[]) => {
    setWallets(ws);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ws));
    } catch {}
  };
  return {
    wallets,
    add: (a: string) => save(Array.from(new Set([...wallets, a]))),
    remove: (a: string) => save(wallets.filter((w) => w !== a)),
  };
}

function isPortfolio(p: unknown): p is Portfolio {
  const o = p as Portfolio;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    Array.isArray(o.wallets) &&
    o.wallets.every((w) => typeof w === "string" && BASE58_RE.test(w))
  );
}

function usePortfolios() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PORTFOLIOS_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) setPortfolios(parsed.filter(isPortfolio));
      }
      setActiveIdState(localStorage.getItem(ACTIVE_PORTFOLIO_KEY));
    } catch {}
  }, []);
  const save = (ps: Portfolio[]) => {
    setPortfolios(ps);
    try {
      localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(ps));
    } catch {}
  };
  const setActiveId = (id: string | null) => {
    setActiveIdState(id);
    try {
      if (id) localStorage.setItem(ACTIVE_PORTFOLIO_KEY, id);
      else localStorage.removeItem(ACTIVE_PORTFOLIO_KEY);
    } catch {}
  };
  return {
    portfolios,
    activeId,
    active: portfolios.find((p) => p.id === activeId) ?? null,
    setActiveId,
    upsert: (p: Portfolio) => {
      const rest = portfolios.filter((x) => x.id !== p.id);
      save([...rest, p].sort((a, b) => a.name.localeCompare(b.name)));
    },
    remove: (id: string) => save(portfolios.filter((x) => x.id !== id)),
  };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
  });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtAmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function signClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}

function WalletInput({
  tracked,
  atLimit,
  onAdd,
  onRemove,
}: {
  tracked: string[];
  atLimit: boolean;
  onAdd: (a: string) => void;
  onRemove: (a: string) => void;
}) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    if (!BASE58_RE.test(s)) {
      setErr("Not a valid base58 wallet address.");
      return;
    }
    if (atLimit && !tracked.includes(s)) {
      setErr(`Wallet limit reached (${MAX_WALLETS_PER_REQUEST}). Remove one first.`);
      return;
    }
    setErr(null);
    onAdd(s);
    setValue("");
  };
  return (
    <div className="panel">
      <input
        className="wallet mono"
        type="text"
        value={value}
        placeholder="Paste a wallet address to track"
        onChange={(e) => {
          setValue(e.target.value);
          setErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(value);
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text").trim();
          if (pasted) {
            e.preventDefault();
            submit(pasted);
          }
        }}
      />
      {err && <p className="neg" style={{ margin: "6px 0 0", fontSize: 12 }}>{err}</p>}
      {tracked.length > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          {tracked.map((w) => (
            <span key={w} className="chip">
              <span className="mono">{shortAddr(w)}</span>
              <button type="button" title="Remove" onClick={() => onRemove(w)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PortfolioEditor({
  initial,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: Portfolio | null;
  onSave: (p: Portfolio) => void;
  onDelete: (() => void) | null;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [walletsText, setWalletsText] = useState(
    (initial?.wallets ?? []).join("\n"),
  );
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Name the portfolio.");
      return;
    }
    const lines = walletsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = lines.find((l) => !BASE58_RE.test(l));
    if (bad) {
      setErr(`Not a valid address: ${bad}`);
      return;
    }
    const unique = Array.from(new Set(lines));
    if (unique.length === 0) {
      setErr("Add at least one wallet.");
      return;
    }
    if (unique.length > MAX_WALLETS_PER_REQUEST) {
      setErr(`Max ${MAX_WALLETS_PER_REQUEST} wallets per portfolio.`);
      return;
    }
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: trimmed,
      wallets: unique,
    });
  };
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2>{initial ? "Edit portfolio" : "New portfolio"}</h2>
      <input
        className="wallet"
        type="text"
        value={name}
        placeholder="Portfolio name"
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        className="wallet mono"
        rows={5}
        value={walletsText}
        placeholder="Wallet addresses, one per line"
        onChange={(e) => setWalletsText(e.target.value)}
      />
      {err && <p className="neg" style={{ margin: 0, fontSize: 12 }}>{err}</p>}
      <div className="row">
        <button type="button" className="btn primary" onClick={submit}>
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function ValueChart({ history }: { history: ValueHistoryResponse }) {
  const points = history.series;
  const last = points.length - 1;
  const [range, setRange] = useState<[number, number] | null>(null);
  useEffect(() => {
    setRange(null);
  }, [points.length]);
  if (points.length === 0) return null;
  const [from, to] = range ?? [0, last];
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(last, Math.max(from, to, lo + 1));
  const view = points.slice(lo, hi + 1);
  const justBuilt = Object.values(history.wallets ?? {}).filter(
    (m) => m.backfilledNow,
  ).length;
  const w = 800;
  const h = 160;
  const values = view.map((p) => p.valueUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (view.length === 1 ? w / 2 : (i / (view.length - 1)) * w);
  const y = (v: number) => h - ((v - min) / span) * (h - 16) - 8;
  const path = view.map((p, i) => `${x(i)},${y(p.valueUsd)}`).join(" ");
  return (
    <div className="panel">
      <h2>
        Value history{" "}
        {history.partial && <span className="badge warn">partial</span>}{" "}
        {history.hasUnpricedDays && <span className="badge warn">unpriced days</span>}{" "}
        {justBuilt > 0 && (
          <span className="badge">
            history just built for {justBuilt} wallet{justBuilt > 1 ? "s" : ""}
          </span>
        )}
      </h2>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        <polyline points={path} fill="none" stroke="#8b5cf6" strokeWidth="2" />
      </svg>
      <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
        <span className="muted">{view[0].day}</span>
        <span>Today: {fmtUsd(history.todayValueUsd)}</span>
        <span className="muted">{view[view.length - 1].day}</span>
      </div>
      {last > 1 && (
        <div style={{ marginTop: 10 }}>
          <input
            type="range"
            min={0}
            max={last - 1}
            value={lo}
            style={{ width: "100%" }}
            onChange={(e) => setRange([Number(e.target.value), hi])}
          />
          <input
            type="range"
            min={1}
            max={last}
            value={hi}
            style={{ width: "100%" }}
            onChange={(e) => setRange([lo, Number(e.target.value)])}
          />
          <div className="row" style={{ justifyContent: "space-between", fontSize: 11 }}>
            <span className="muted">
              slide to pan — full range {points[0].day} → {points[last].day}
            </span>
            {range && (
              <button type="button" className="btn" onClick={() => setRange(null)}>
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Dashboard() {
  const { publicKey } = useWallet();
  const connected = publicKey?.toBase58() ?? null;
  const tracked = useTrackedWallets();
  const folios = usePortfolios();
  const [editing, setEditing] = useState<"new" | Portfolio | null>(null);

  const allWallets = useMemo(() => {
    if (folios.active) return folios.active.wallets;
    const set = new Set<string>();
    if (connected) set.add(connected);
    for (const w of tracked.wallets) set.add(w);
    return Array.from(set);
  }, [connected, tracked.wallets, folios.active]);
  const wallets = useMemo(
    () => allWallets.slice(0, MAX_WALLETS_PER_REQUEST),
    [allWallets],
  );
  const excludedCount = allWallets.length - wallets.length;

  const holdings = usePost<HoldingsResponse>("/api/portfolio/holdings", wallets);
  const pnl = usePost<TradePnLResult>("/api/portfolio/pnl", wallets);
  const history = usePost<ValueHistoryResponse>("/api/portfolio/value-history", wallets);

  const pnlByMint = useMemo(() => {
    const map = new Map<string, { costBasis: number; pnl: number }>();
    for (const rows of Object.values(pnl.data?.perWallet ?? {})) {
      for (const r of rows) {
        const cur = map.get(r.mint) ?? { costBasis: 0, pnl: 0 };
        cur.costBasis += r.costBasis;
        cur.pnl += r.pnl;
        map.set(r.mint, cur);
      }
    }
    return map;
  }, [pnl.data]);

  const summary = pnl.data?.summary ?? null;
  const trades = pnl.data?.tradeHistory ?? [];
  const unpricedHeld = (holdings.data?.merged.tokens ?? []).filter(
    (t) => t.balance > 0 && t.price <= 0,
  );

  return (
    <div className="wrap">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong style={{ fontSize: 18 }}>Portfolio Mockup</strong>
        </div>
        <UnifiedWalletButton />
      </div>

      <div className="row">
        <button
          type="button"
          className={`chip${folios.active ? "" : " active"}`}
          onClick={() => folios.setActiveId(null)}
        >
          All wallets
        </button>
        {folios.portfolios.map((p) => (
          <span key={p.id} className={`chip${folios.activeId === p.id ? " active" : ""}`}>
            <button type="button" onClick={() => folios.setActiveId(p.id)}>
              {p.name} ({p.wallets.length})
            </button>
            <button type="button" title="Edit" onClick={() => setEditing(p)}>
              ✎
            </button>
          </span>
        ))}
        <button type="button" className="chip" onClick={() => setEditing("new")}>
          ＋ New portfolio
        </button>
      </div>

      {editing && (
        <PortfolioEditor
          initial={editing === "new" ? null : editing}
          onSave={(p) => {
            folios.upsert(p);
            folios.setActiveId(p.id);
            setEditing(null);
          }}
          onDelete={
            editing === "new"
              ? null
              : () => {
                  folios.remove(editing.id);
                  if (folios.activeId === editing.id) folios.setActiveId(null);
                  setEditing(null);
                }
          }
          onCancel={() => setEditing(null)}
        />
      )}

      {!folios.active && (
        <WalletInput
          tracked={tracked.wallets.filter((w) => w !== connected)}
          atLimit={allWallets.length >= MAX_WALLETS_PER_REQUEST}
          onAdd={tracked.add}
          onRemove={tracked.remove}
        />
      )}

      {excludedCount > 0 && (
        <span className="badge warn">
          {excludedCount} wallet{excludedCount > 1 ? "s" : ""} excluded — results
          below cover only the first {MAX_WALLETS_PER_REQUEST} wallets (API limit).
          Remove wallets to include them.
        </span>
      )}

      {wallets.length === 0 && (
        <p className="muted" style={{ textAlign: "center" }}>
          Connect a wallet or paste an address to load a portfolio.
        </p>
      )}

      {wallets.length > 0 && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="label">Net worth</div>
              <div className="value">{fmtUsd(holdings.data?.merged.totalValue)}</div>
            </div>
            <div className="stat">
              <div className="label">Invested</div>
              <div className="value">{fmtUsd(summary?.investedTotal)}</div>
            </div>
            <div className="stat">
              <div className="label">All-time PnL</div>
              <div className={`value ${signClass(summary?.absoluteReturnUsd)}`}>
                {fmtUsd(summary?.absoluteReturnUsd)}{" "}
                <span style={{ fontSize: 13 }}>{fmtPct(summary?.absoluteReturnPct)}</span>
              </div>
            </div>
          </div>

          {(pnl.data?.hasUnpriced || pnl.data?.historyTruncated) && (
            <div className="row">
              {pnl.data.hasUnpriced && (
                <span className="badge warn">
                  unpriced:{" "}
                  {unpricedHeld.length > 0 &&
                    `${unpricedHeld.length} held (${unpricedHeld
                      .slice(0, 5)
                      .map((t) => t.symbol || shortAddr(t.address))
                      .join(", ")}${unpricedHeld.length > 5 ? "…" : ""}); `}
                  some events had no day-of price — excluded from cost basis and
                  trade history, never guessed
                </span>
              )}
              {pnl.data.historyTruncated && <span className="badge warn">history truncated</span>}
            </div>
          )}

          {history.loading && (
            <p className="muted" style={{ fontSize: 12 }}>
              Building value history — the first load for a new wallet computes
              its full daily series and can take a while…
            </p>
          )}
          {history.data && <ValueChart history={history.data} />}
          {history.error && (
            <p className="muted" style={{ fontSize: 12 }}>Value history: {history.error}</p>
          )}

          <div className="panel scroll">
            <h2>Holdings</h2>
            {holdings.loading && <p className="muted">Loading holdings…</p>}
            {holdings.error && <p className="neg">Error: {holdings.error}</p>}
            {holdings.data && (
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Balance</th>
                    <th>Price</th>
                    <th>Value</th>
                    <th>Cost basis</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.data.merged.tokens.map((t) => {
                    const p = pnlByMint.get(t.address);
                    return (
                      <tr key={t.address}>
                        <td>
                          <span className="token">
                            <span>{t.symbol || shortAddr(t.address)}</span>
                          </span>
                        </td>
                        <td className="mono">{fmtAmt(t.balance)}</td>
                        <td className="mono">
                          {t.price > 0 ? (
                            fmtUsd(t.price)
                          ) : (
                            <span className="badge warn">unpriced</span>
                          )}
                        </td>
                        <td className="mono">{fmtUsd(t.value)}</td>
                        <td className="mono muted">{p ? fmtUsd(p.costBasis) : "—"}</td>
                        <td className={`mono ${signClass(p?.pnl)}`}>
                          {p ? fmtUsd(p.pnl) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel scroll">
            <h2>Trade history</h2>
            {pnl.loading && <p className="muted">Loading PnL and trades…</p>}
            {pnl.error && <p className="neg">Error: {pnl.error}</p>}
            {trades.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Side</th>
                    <th>Token</th>
                    <th>Amount</th>
                    <th>USD</th>
                    <th>Source</th>
                    {wallets.length > 1 && <th>Wallet</th>}
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 50).map((t, i) => (
                    <tr key={`${t.signature ?? i}-${t.mint}-${i}`}>
                      <td>{t.ts ? new Date(t.ts * 1000).toISOString().slice(0, 10) : "—"}</td>
                      <td className={t.side === "buy" ? "pos" : "neg"}>{t.side}</td>
                      <td>{t.symbol || shortAddr(t.mint)}</td>
                      <td className="mono">{fmtAmt(t.amount)}</td>
                      <td className="mono">{fmtUsd(t.usd)}</td>
                      <td className="muted">{t.source || (t.fromExternal ? "transfer" : "—")}</td>
                      {wallets.length > 1 && <td className="mono muted">{t.walletShort}</td>}
                      <td>
                        {t.signature ? (
                          <a
                            href={`https://explorer.solana.com/tx/${t.signature}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            ↗
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {pnl.data && trades.length === 0 && <p className="muted">No trades found.</p>}
          </div>
        </>
      )}
    </div>
  );
}

export default function Page() {
  const config = useMemo(
    () => ({
      autoConnect: true,
      env: "mainnet-beta" as const,
      metadata: {
        name: "Portfolio Mockup",
        description: "Throwaway UI for testing the portfolio API",
        url: typeof window !== "undefined" ? window.location.origin : "",
        iconUrls: [] as string[],
      },
      theme: "dark" as const,
    }),
    [],
  );
  return (
    <UnifiedWalletProvider wallets={[]} config={config}>
      <Dashboard />
    </UnifiedWalletProvider>
  );
}
