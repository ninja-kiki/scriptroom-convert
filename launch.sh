#!/bin/bash

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$(dirname "$0")"

# 기존 프로세스 정리
lsof -ti:3001 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# npm install (node_modules 없을 때)
if [ ! -d "node_modules" ]; then
  npm install
fi

# 서버 시작
node server.js &
SERVER_PID=$!

# Vite 시작
npx vite &
VITE_PID=$!

# 브라우저 열기 (Vite 뜰 때까지 대기)
sleep 6
open http://localhost:5173

# 종료 시 같이 종료
wait $SERVER_PID $VITE_PID
