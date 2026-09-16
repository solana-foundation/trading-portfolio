# DeFi position coverage map

The portfolio API values SPL/Token-2022 balances only. Positions held inside
DeFi programs are invisible to `getHoldings` unless they surface as a priced
receipt token, so every program-side position is a known coverage gap. This
map enumerates the top protocols, the on-chain footprint a wallet's position
leaves, and how `scripts/defi-gaps.mjs` detects it.

## Detection classes

- **position-nft** — the wallet holds an NFT (amount 1, decimals 0) whose
  mint is referenced by a program account (`memcmp` at `mintOffset`).
- **owner-account** — the program stores a per-user account embedding the
  wallet pubkey (`memcmp` at `ownerOffset`, discovered empirically with
  `defi-gaps.mjs discover <protocol>`).
- **receipt-token** — the position is an SPL token in the wallet (LSTs, LP
  and PT tokens). Already counted by holdings iff the vendor prices the mint;
  the gap report flags held receipt mints missing from the API response.

## Registry

| Protocol | Program | Class | Detect | Status |
| --- | --- | --- | --- | --- |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | position-nft | mintOffset 40 | verified live |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | position-nft | mintOffset 9 | verified live |
| Kamino Lend | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | owner-account | ownerOffset 64 | verified live |
| Kamino Farms | `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr` | owner-account | ownerOffset 48 | verified live |
| Drift | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` | owner-account | ownerOffset 8 | registry |
| marginfi v2 | `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` | owner-account | ownerOffset 40 | verified live |
| Solend/Save | `So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo` | owner-account | ownerOffset 42 | verified live |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | owner-account | ownerOffset 40 | verified live |
| Meteora DAMM | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | receipt-token | holdings | via holdings |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | receipt-token | holdings | via holdings |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | receipt-token | holdings | via holdings |
| Jupiter Perps (JLP) | `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu` | receipt-token | JLP mint | via holdings |
| Marinade (mSOL) | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | receipt-token | mSOL mint | via holdings |
| Jito (jitoSOL) | `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb` | receipt-token | jitoSOL mint | via holdings |
| Sanctum (LSTs/INF) | `5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx` | receipt-token | holdings | via holdings |
| Lulo | `FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q` | owner-account | ownerOffset 16 | verified live |
| Exponent (PT) | `ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7` | receipt-token | holdings | via holdings (PT mints unpriced by vendor) |
| Save cTokens | same as Solend | receipt-token | holdings | via holdings |
| Lifinity v2 | `2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c` | receipt-token | holdings | via holdings |
| Loopscale | `1oopBoJG58DgkUCBUzAHNYLPC1DsbeVGtDMcJEbLNKV` | owner-account | discover | registry |

`registry` status means the program is mapped but the detector offset has not
been confirmed against live accounts yet — run
`node scripts/defi-gaps.mjs discover <protocol>` to confirm the offset and
collect sample wallets, then promote it. Wrong program ids or offsets fail
toward "no positions found", so promotion requires a positive live detection.

## Usage

```
HELIUS_API_KEY=… node scripts/defi-gaps.mjs scan <wallet>
HELIUS_API_KEY=… node scripts/defi-gaps.mjs discover <protocol>
HELIUS_API_KEY=… node scripts/defi-gaps.mjs report <api-url> <wallet> [wallet…]
```

`report` compares on-chain detections against the API's holdings response and
prints one JSON line per gap. The smoke script runs it informationally when
`DEFI_GAP_WALLETS` (comma-separated) is set; set `DEFI_GAPS_STRICT=true` to
make gaps fail the run once position support ships.

## Unknown-protocol detection

Anything the registry does not cover is still surfaced rather than silently
ignored, so new protocols become alerts instead of blind spots:

- **Unmatched position NFTs** — scanned amount-1/decimals-0 mints not claimed
  by any position-nft detector are reported as `NOTE_UNMATCHED_NFTS` (notes,
  not strict failures: they may be ordinary collectibles). The scan covers the
  first 100 NFT-like mints; anything beyond that is surfaced as
  `NOTE_NFT_SCAN_TRUNCATED`, never silently skipped.
- **Unknown program interactions** — the wallet's last 100 transactions are
  scanned for program ids outside the infra allowlist. Interactions with a
  registry protocol that has no working detector yet are reported as
  `PROTOCOL_INTERACTION_UNVERIFIED`; everything else is
  `ALERT_UNKNOWN_PROTOCOL` with an interaction count. Triage by adding a
  detector, receipt mints, or an infra allowlist entry.
- **Scan availability** — when the interaction scan cannot run (no
  `HELIUS_API_KEY`, vendor error, rate limit), the report emits
  `ALERT_UNKNOWN_SCAN_UNAVAILABLE` instead of silently looking clean.

`DEFI_GAPS_STRICT=true` fails the run on any non-`NOTE_` row, and smoke.sh
propagates that failure; without it the report is informational.
