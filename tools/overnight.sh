#!/bin/bash
# 자리 비운 사이 한 번에: 서버 → KoC 재번역(전체) → 소셜 재번역(resume) → RESYNC 재컴파일+배포 → 서버종료
# 단일 프로세스라 끊김 없이 순차 실행. (자식 프로세스는 메시지로 안 죽음)
set +e
SRC=/Users/hojun/Projects/scriptroom-convert-local
SR=/Users/hojun/Projects/scriptroom
cd "$SRC"
ts() { date +%H:%M; }

echo "[$(ts)] === 시작 ==="
lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null
node server.js > /tmp/overnight-server.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s -m2 http://localhost:3001/api/health >/dev/null 2>&1 && break; sleep 1; done
if ! curl -s -m2 http://localhost:3001/api/health >/dev/null 2>&1; then echo "[$(ts)] ✗ 서버 안 뜸 — 중단"; exit 1; fi
echo "[$(ts)] 서버 OK (pid $SRV)"

echo "[$(ts)] --- 코미디의 왕 재번역(전체) ---"
node tools/retranslate.mjs the-king-of-comedy --write 2>&1 | grep -vE "Warning|standardFont"
echo "[$(ts)] --- 소셜네트워크 재번역(resume, 영어 씬만) ---"
node tools/retranslate.mjs the-social-network --write --resume 2>&1 | grep -vE "Warning|standardFont"

echo "[$(ts)] 서버 종료"
kill "$SRV" 2>/dev/null
lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null

echo "[$(ts)] --- 재컴파일(RESYNC) + 배포 ---"
cd "$SR"
RESYNC=the-king-of-comedy,the-social-network bash deploy.sh --skip-meta "코미디의왕·소셜네트워크 PDF 템포 재변환 + 재번역(가이드-온리)"
echo "[$(ts)] === 완료 ==="
