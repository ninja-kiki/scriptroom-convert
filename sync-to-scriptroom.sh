#!/bin/bash
# sync-to-scriptroom.sh
# scriptroom-convert-local (소스 오브 트루스) → scriptroom 동기화
# 실행: bash sync-to-scriptroom.sh

SRC_LIB="$(dirname "$0")/src/lib"
SRC_COMP="$(dirname "$0")/src/components"
DST_LIB=~/Projects/scriptroom/src/convert-lib
DST_COMP=~/Projects/scriptroom/src/convert-components

echo "🔄 scriptroom-convert-local → scriptroom 동기화 중..."

# lib 파일 복사 (경로 치환 없이)
for f in "$SRC_LIB"/*.js; do
  cp "$f" "$DST_LIB/$(basename "$f")"
  echo "  ✓ lib/$(basename "$f")"
done

# component 파일 복사 (../lib/ → ../convert-lib/ 경로 치환)
for f in "$SRC_COMP"/*.jsx; do
  sed 's|from '"'"'\.\./lib/|from '"'"'\.\./convert-lib/|g' "$f" > "$DST_COMP/$(basename "$f")"
  echo "  ✓ comp/$(basename "$f")"
done

echo ""
echo "✅ 완료 — lib $(ls "$DST_LIB" | wc -l | tr -d ' ')개, components $(ls "$DST_COMP" | wc -l | tr -d ' ')개"
echo "   scriptroom 배포 전에 git push 잊지 마세요"
