import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Portfolio Mockup",
  description: "Throwaway UI for testing the portfolio API with wallets",
};

const css = `
:root {
  --bg: #0b0e14;
  --panel: #12161f;
  --panel-2: #191f2b;
  --border: #232b3a;
  --text: #e6e9ef;
  --muted: #8a93a5;
  --accent: #8b5cf6;
  --pos: #22c55e;
  --neg: #ef4444;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; display: flex; flex-direction: column; gap: 20px; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.muted { color: var(--muted); }
.pos { color: var(--pos); }
.neg { color: var(--neg); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
input.wallet {
  width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--panel-2); color: var(--text); outline: none; font-size: 14px;
}
input.wallet:focus { border-color: var(--accent); }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid rgba(139, 92, 246, 0.4); background: rgba(139, 92, 246, 0.12);
  color: #c4b5fd; font-size: 12px;
}
.chip button { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; padding: 0; font-size: 14px; }
.chip button:hover { opacity: 1; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.stat .value { font-size: 20px; font-weight: 600; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
th:first-child, td:first-child { text-align: left; }
tr:last-child td { border-bottom: none; }
.token { display: flex; align-items: center; gap: 8px; }
.token img { width: 20px; height: 20px; border-radius: 50%; }
.scroll { overflow-x: auto; }
h2 { font-size: 15px; margin: 0 0 10px; }
a { color: var(--accent); text-decoration: none; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.badge.warn { border-color: rgba(239, 68, 68, 0.5); color: #fca5a5; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{css}</style>
        {children}
      </body>
    </html>
  );
}
