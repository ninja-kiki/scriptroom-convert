#!/bin/bash
# 더블클릭하면 앱이 켜집니다. (터미널 입력 불필요)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
lsof -ti:3001 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null
if [ ! -d "node_modules" ]; then
  echo "처음 실행 — 준비 중입니다 (1~2분)..."
  npm install
fi
node server.js &
npx vite &
sleep 6
open http://localhost:5173
wait
