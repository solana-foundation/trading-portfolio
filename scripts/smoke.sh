#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:?usage: smoke.sh <base-url>}"
REQUIRE_DATA="${REQUIRE_DATA:-false}"
WALLET="${SMOKE_WALLET:-86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY}"

AUTH_ARGS=()
if [ -n "${AUTH_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $AUTH_TOKEN")
fi

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

code=$(curl -sS -o /tmp/smoke_bad.json -w '%{http_code}' --max-time 30 \
  "${AUTH_ARGS[@]}" \
  -X POST "$BASE_URL/api/portfolio/summary" -H 'Content-Type: application/json' -d '{}')
[ "$code" = "400" ] || fail "bad-request probe expected 400, got $code"
echo "bad-request probe: 400"

for ep in summary holdings pnl trades; do
  code=$(curl -sS -o "/tmp/smoke_$ep.json" -w '%{http_code}' --max-time 120 \
    "${AUTH_ARGS[@]}" \
    -X POST "$BASE_URL/api/portfolio/$ep" -H 'Content-Type: application/json' \
    -d "{\"wallets\":[\"$WALLET\"]}")
  case "$code" in
    2*)
      jq empty "/tmp/smoke_$ep.json" || fail "$ep returned non-JSON body"
      echo "$ep: $code"
      ;;
    502)
      [ "$REQUIRE_DATA" = "true" ] && fail "$ep returned $code"
      jq -e '.error | type == "string"' "/tmp/smoke_$ep.json" >/dev/null \
        || fail "$ep returned $code without structured error"
      echo "$ep: $code (vendor data path degraded, allowed until REQUIRE_DATA=true)"
      ;;
    *)
      fail "$ep returned $code"
      ;;
  esac
done

if [ -n "${DEFI_GAP_WALLETS:-}" ]; then
  if [ -n "${HELIUS_API_KEY:-}" ] || [ -n "${RPC_URL:-}" ]; then
    echo "defi gap report (informational):"
    node "$(dirname "$0")/defi-gaps.mjs" report "$BASE_URL" \
      $(echo "$DEFI_GAP_WALLETS" | tr ',' ' ') || true
  else
    echo "defi gap report skipped: no HELIUS_API_KEY/RPC_URL"
  fi
fi

echo "SMOKE OK"
