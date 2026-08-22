#!/usr/bin/env bash
# 골든 픽스처 최신성 검사 — **원작이 바뀌었는데 픽스처가 낡으면 여기서 막는다.**
#
# `pnpm test`는 커밋된 JSON만 읽는다. 그래서 원작 C#이 바뀌어도 픽스처가 그대로면
# 테스트도 배포도 전부 통과한다 — 골든이 "예전의 원작"과 대조하고 있는 셈이다
# (적대적 리뷰 R5). 하네스를 임시 파일에 다시 돌려 커밋본과 **바이트 단위로** 비교한다.
#
# 원작 레포가 없으면 **건너뛴다**: 형제 폴더가 없는 기계에서 빨간불을 내면
# 아무도 신뢰하지 않는 검사가 된다. 대신 건너뛴 사실을 크게 남긴다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BALANCE="${SCRAP_BALANCE_PATH:-$ROOT/../scrapworks/unity/Assets/Resources/balance.json}"
COMMITTED="$ROOT/golden/fixtures/core.json"

if [ ! -f "$BALANCE" ]; then
  echo "⚠ 원작 레포를 찾지 못했다 ($BALANCE) — 골든 최신성 검사를 건너뛴다."
  echo "  커밋된 픽스처가 현재 원작과 같은지 **확인되지 않았다.**"
  exit 0
fi

if ! command -v dotnet >/dev/null 2>&1; then
  echo "⚠ dotnet이 없어 골든 최신성 검사를 건너뛴다 — 픽스처 최신 여부는 확인되지 않았다."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "하네스를 다시 실행해 픽스처를 재생성한다…"
SCRAP_BALANCE_PATH="$BALANCE" dotnet run --project "$ROOT/golden/harness" -c Release \
  --no-launch-profile -- "$TMP/core.json" >/dev/null

if cmp -s "$TMP/core.json" "$COMMITTED"; then
  echo "✓ 골든 픽스처가 현재 원작과 일치한다."
  exit 0
fi

echo "✗ 커밋된 픽스처가 원작과 다르다 — 원작이 바뀌었거나 하네스가 바뀌었다."
echo "  다시 만들려면: pnpm golden"
echo "  차이 (앞 40줄):"
diff <(python3 -m json.tool "$COMMITTED" 2>/dev/null || cat "$COMMITTED") \
     <(python3 -m json.tool "$TMP/core.json" 2>/dev/null || cat "$TMP/core.json") | head -40 || true
exit 1
