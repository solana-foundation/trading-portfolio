export type SolanaAddress = string;

export type TokenHolding = {
  address: SolanaAddress;
  symbol?: string;
  name?: string;
  icon?: string;
  balance: number;
  price: number;
  value: number;
};

export type Holdings = {
  tokens: TokenHolding[];
  totalValue: number;
  unpricedCount: number;
};

export type CashEvent = {
  kind: "buy_swap" | "sell_swap" | "buy_transfer";
  mint: SolanaAddress;
  amount: number;
  usd: number;
  ts: number;
  signature?: string | null;
  source?: string | null;
};

export type BuyAggregate = {
  amountBought: number;
  totalCostUsd: number;
  txCount: number;
  firstTs: number;
  lastTs: number;
};

export type SellAggregate = {
  amountSold: number;
  totalProceedsUsd: number;
  txCount: number;
  firstTs: number;
  lastTs: number;
};

export type TradePnLRow = {
  mint: SolanaAddress;
  symbol?: string;
  name?: string;
  icon?: string;
  currentAmount: number;
  currentPrice: number;
  currentValue: number;
  costBasis: number;
  avgCostPerToken: number;
  pnl: number;
  pnlPercent: number;
  householdSpent: number | null;
  householdBought: number | null;
  householdHeld: number | null;
  txCount: number;
  costSource: string;
  attribution: "wallet" | "household";
};

export type TradeHistoryRow = {
  kind: "buy_swap" | "sell_swap" | "buy_transfer";
  side: "buy" | "sell";
  wallet: SolanaAddress;
  walletShort: string;
  mint: SolanaAddress;
  symbol?: string | null;
  amount: number;
  usd: number;
  ts: number;
  signature?: string | null;
  source?: string | null;
  fromExternal: boolean;
  fromAccount?: string | null;
};

export type TradePnLSummary = {
  currentValue: number;
  investedTotal: number;
  investedGross: number;
  realizedReceipts: number;
  absoluteReturnUsd: number;
  absoluteReturnPct: number | null;
  xirrPct: number | null;
  benchmarkSolXirrPct: number | null;
  cashflowCount: number;
};

export type MintCost = {
  mint: SolanaAddress;
  symbol: string | null;
  avgCostPerToken: number;
};

export type TradePnLResult = {
  perWallet: Record<SolanaAddress, TradePnLRow[]>;
  mintCosts: MintCost[];
  totals: { totalPnL: number; totalCostBasis: number; totalValue: number };
  summary: TradePnLSummary;
  tradeHistory: TradeHistoryRow[];
  solPriceUsd: number;
  walletsScanned: number;
  hasUnpriced: boolean;
  historyTruncated: boolean;
};
