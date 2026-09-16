const RPC_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : process.env.RPC_URL;

const REGISTRY = [
  { name: "orca-whirlpool", program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", kind: "position-nft", mintOffset: 40 },
  { name: "raydium-clmm", program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", kind: "position-nft", mintOffset: 9 },
  { name: "kamino-lend", program: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", kind: "owner-account", ownerOffset: 64 },
  { name: "kamino-farms", program: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr", kind: "owner-account", ownerOffset: 48 },
  { name: "drift", program: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", kind: "owner-account", ownerOffset: 8 },
  { name: "marginfi-v2", program: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", kind: "owner-account", ownerOffset: 40 },
  { name: "solend", program: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo", kind: "owner-account", ownerOffset: 42 },
  { name: "meteora-dlmm", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", kind: "owner-account", ownerOffset: 40 },
  { name: "meteora-damm", program: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", kind: "receipt-token" },
  { name: "raydium-amm-v4", program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", kind: "receipt-token" },
  { name: "raydium-cpmm", program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", kind: "receipt-token" },
  { name: "jupiter-perps-jlp", program: "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu", kind: "receipt-token", mints: ["27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"] },
  { name: "marinade-msol", program: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", kind: "receipt-token", mints: ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"] },
  { name: "jito-jitosol", program: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb", kind: "receipt-token", mints: ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"] },
  { name: "sanctum-lsts", program: "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx", kind: "receipt-token" },
  { name: "lulo", program: "FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q", kind: "owner-account", ownerOffset: 16 },
  { name: "exponent-pt", program: "ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7", kind: "receipt-token" },
  { name: "save-ctoken", program: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo", kind: "receipt-token" },
  { name: "lifinity-v2", program: "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", kind: "receipt-token" },
  { name: "loopscale", program: "1oopBoJG58DgkUCBUzAHNYLPC1DsbeVGtDMcJEbLNKV", kind: "owner-account", ownerOffset: null },
];

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

const INFRA_PROGRAMS = new Set([
  ...TOKEN_PROGRAMS,
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu",
  "AddressLookupTab1e1111111111111111111111111",
]);

const NFT_SCAN_CAP = 100;

function hasDetector(proto) {
  if (proto.kind === "owner-account") return proto.ownerOffset != null;
  if (proto.kind === "position-nft") return true;
  return Boolean(proto.mints);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(str) {
  let n = 0n;
  for (const c of str) n = n * 58n + BigInt(B58.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c === "1") out.unshift(0);
    else break;
  }
  return Uint8Array.from(out);
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function tokenAccounts(wallet) {
  const out = [];
  for (const programId of TOKEN_PROGRAMS) {
    const res = await rpc("getTokenAccountsByOwner", [
      wallet,
      { programId },
      { encoding: "jsonParsed" },
    ]);
    for (const acc of res.value) {
      out.push(acc.account.data.parsed.info);
    }
  }
  return out;
}

async function scanWallet(wallet) {
  const accounts = await tokenAccounts(wallet);
  const nftMints = accounts
    .filter((a) => a.tokenAmount.decimals === 0 && a.tokenAmount.amount === "1")
    .map((a) => a.mint);
  const heldMints = new Set(
    accounts.filter((a) => Number(a.tokenAmount.amount) > 0).map((a) => a.mint),
  );

  const findings = [];
  const claimedNfts = new Set();
  const scannedNfts = nftMints.slice(0, NFT_SCAN_CAP);
  for (const proto of REGISTRY) {
    if (proto.kind === "owner-account") {
      if (proto.ownerOffset == null) continue;
      const res = await rpc("getProgramAccounts", [
        proto.program,
        {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: proto.ownerOffset, bytes: wallet } }],
        },
      ]);
      if (res.length > 0) {
        findings.push({ protocol: proto.name, status: "position", count: res.length });
      }
    } else if (proto.kind === "position-nft") {
      let count = 0;
      for (const mint of scannedNfts) {
        const res = await rpc("getProgramAccounts", [
          proto.program,
          {
            encoding: "base64",
            dataSlice: { offset: 0, length: 0 },
            filters: [{ memcmp: { offset: proto.mintOffset, bytes: mint } }],
          },
        ]);
        if (res.length > 0) {
          count += 1;
          claimedNfts.add(mint);
        }
      }
      if (count > 0) {
        findings.push({ protocol: proto.name, status: "position", count });
      }
    } else if (proto.kind === "receipt-token" && proto.mints) {
      const held = proto.mints.filter((m) => heldMints.has(m));
      if (held.length > 0) {
        findings.push({ protocol: proto.name, status: "receipt-held", mints: held });
      }
    }
  }

  const unknownNfts = scannedNfts.filter((m) => !claimedNfts.has(m));
  if (unknownNfts.length > 0) {
    findings.push({
      protocol: "unknown",
      status: "unmatched-nft",
      count: unknownNfts.length,
      mints: unknownNfts.slice(0, 10),
    });
  }
  if (nftMints.length > scannedNfts.length) {
    findings.push({
      protocol: "unknown",
      status: "nft-scan-truncated",
      unscanned: nftMints.length - scannedNfts.length,
    });
  }

  const interactions = await programInteractions(wallet);
  if (interactions === null) {
    findings.push({ protocol: "unknown", status: "scan-unavailable" });
  } else {
    const detectorPrograms = new Set(
      REGISTRY.filter(hasDetector).map((p) => p.program),
    );
    const byProgram = new Map(REGISTRY.map((p) => [p.program, p]));
    const unknown = [];
    const unverified = [];
    for (const it of interactions) {
      if (detectorPrograms.has(it.program)) continue;
      const proto = byProgram.get(it.program);
      if (!proto) unknown.push(it);
      else unverified.push({ ...it, protocol: proto.name });
    }
    if (unverified.length > 0) {
      findings.push({ protocol: "registry", status: "interaction-unverified", programs: unverified });
    }
    if (unknown.length > 0) {
      findings.push({ protocol: "unknown", status: "unknown-programs", programs: unknown });
    }
  }
  return findings;
}

async function programInteractions(wallet) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  let txs;
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=100`,
    );
    if (!res.ok) return null;
    txs = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(txs)) return null;
  const counts = new Map();
  for (const tx of txs) {
    for (const ix of tx.instructions || []) {
      const pid = ix.programId;
      if (!pid || INFRA_PROGRAMS.has(pid)) continue;
      counts.set(pid, (counts.get(pid) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([program, txCount]) => ({ program, txCount }));
}

async function discover(protoName, sampleTxs = 12) {
  const proto = REGISTRY.find((p) => p.name === protoName);
  if (!proto) throw new Error(`unknown protocol ${protoName}`);
  const sigs = (
    await rpc("getSignaturesForAddress", [proto.program, { limit: 30 }])
  )
    .filter((s) => !s.err)
    .slice(0, sampleTxs)
    .map((s) => s.signature);

  const offsetVotes = new Map();
  const wallets = new Set();
  for (const sig of sigs) {
    let tx;
    try {
      tx = await rpc("getTransaction", [
        sig,
        { maxSupportedTransactionVersion: 1, encoding: "json" },
      ]);
    } catch {
      continue;
    }
    if (!tx) continue;
    const keys = tx.transaction.message.accountKeys;
    const feePayer = keys[0];
    const feePayerBytes = b58decode(feePayer);
    for (const key of keys.slice(1, 20)) {
      let info;
      try {
        info = await rpc("getAccountInfo", [key, { encoding: "base64" }]);
      } catch {
        continue;
      }
      if (!info?.value || info.value.owner !== proto.program) continue;
      const data = Buffer.from(info.value.data[0], "base64");
      const idx = data.indexOf(Buffer.from(feePayerBytes));
      if (idx >= 0) {
        offsetVotes.set(idx, (offsetVotes.get(idx) || 0) + 1);
        wallets.add(feePayer);
      }
    }
  }
  const ranked = [...offsetVotes.entries()].sort((a, b) => b[1] - a[1]);
  return { protocol: protoName, ownerOffsetCandidates: ranked, sampleWallets: [...wallets] };
}

async function apiReport(apiUrl, wallets, authToken) {
  const headers = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${apiUrl}/api/portfolio/holdings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wallets }),
  });
  if (!res.ok) throw new Error(`holdings HTTP ${res.status}`);
  const body = await res.json();
  return body;
}

async function report(apiUrl, wallets) {
  const rows = [];
  for (const wallet of wallets) {
    const findings = await scanWallet(wallet);
    const holdings = await apiReport(apiUrl, [wallet], process.env.AUTH_TOKEN);
    const perWallet = holdings.perWallet[wallet];
    const apiValue = perWallet?.totalValue ?? 0;
    const apiMints = new Set((perWallet?.tokens || []).map((t) => t.address));
    for (const f of findings) {
      if (f.status === "position") {
        rows.push({ wallet, protocol: f.protocol, gap: "POSITION_NOT_IN_API", count: f.count, apiValueUsd: Math.round(apiValue) });
      } else if (f.status === "receipt-held") {
        const missing = f.mints.filter((m) => !apiMints.has(m));
        if (missing.length > 0) {
          rows.push({ wallet, protocol: f.protocol, gap: "RECEIPT_UNPRICED_OR_MISSING", mints: missing, apiValueUsd: Math.round(apiValue) });
        }
      } else if (f.status === "unmatched-nft") {
        rows.push({ wallet, protocol: "unknown", gap: "NOTE_UNMATCHED_NFTS", count: f.count, mints: f.mints });
      } else if (f.status === "nft-scan-truncated") {
        rows.push({ wallet, protocol: "unknown", gap: "NOTE_NFT_SCAN_TRUNCATED", unscanned: f.unscanned });
      } else if (f.status === "scan-unavailable") {
        rows.push({ wallet, protocol: "unknown", gap: "ALERT_UNKNOWN_SCAN_UNAVAILABLE" });
      } else if (f.status === "interaction-unverified") {
        rows.push({ wallet, protocol: "registry", gap: "PROTOCOL_INTERACTION_UNVERIFIED", programs: f.programs });
      } else if (f.status === "unknown-programs") {
        rows.push({ wallet, protocol: "unknown", gap: "ALERT_UNKNOWN_PROTOCOL", programs: f.programs });
      }
    }
  }
  return rows;
}

const [, , mode, ...args] = process.argv;
if (!RPC_URL) {
  console.error("set HELIUS_API_KEY or RPC_URL");
  process.exit(2);
}
if (mode === "scan") {
  console.log(JSON.stringify(await scanWallet(args[0]), null, 2));
} else if (mode === "discover") {
  console.log(JSON.stringify(await discover(args[0]), null, 2));
} else if (mode === "report") {
  const [apiUrl, ...wallets] = args;
  const rows = await report(apiUrl, wallets);
  for (const row of rows) console.log(JSON.stringify(row));
  const enforced = rows.filter((r) => !r.gap.startsWith("NOTE_"));
  console.log(
    `defi-gaps: ${enforced.length} gap(s), ${rows.length - enforced.length} note(s) across ${wallets.length} wallet(s)`,
  );
  if (process.env.DEFI_GAPS_STRICT === "true" && enforced.length > 0) process.exit(1);
} else {
  console.error("usage: defi-gaps.mjs scan <wallet> | discover <protocol> | report <api-url> <wallet...>");
  process.exit(2);
}
