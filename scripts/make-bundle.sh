#!/usr/bin/env bash
# 업로드용 번들 — 빌드까지 함께 한다.
#
#   pnpm bundle v0.1.0
#
# **빌드를 여기서 하는 이유**: 따로 하면 버전이 파일명에만 들어가고 번들 안에 구워진
# 버전은 이전 값으로 남는다 (소울 던전에서 실제로 겪은 어긋남).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)}"
DIST="$ROOT/web/dist"
OUT="$ROOT/scrapworks-web-$VERSION.tar.gz"

echo "빌드 (GAME_VERSION=$VERSION)"
GAME_VERSION="$VERSION" pnpm -C "$ROOT" -F @scrapworks/web build

if [ ! -f "$DIST/index.html" ]; then
  echo "web/dist/index.html이 없다 — 빌드 실패" >&2
  exit 1
fi

# tar 루트에 index.html이 바로 오게 dist 안에서 묶는다 — 서버 검증이 루트 index.html을 본다
tar -czf "$OUT" -C "$DIST" .
echo "번들 생성: $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"
