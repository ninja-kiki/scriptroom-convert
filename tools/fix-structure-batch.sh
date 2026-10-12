#!/bin/bash
# 여러 작품의 영문·한글 구조 어긋남을 한 편씩 바로잡는 배치 — 오래 돌려도 안전하게.
#   · 작품마다 시작 전에 번역이 실제로 되는지 확인하고, 사용량 한도·로그인 풀림이면 10분마다 재확인하며 기다린다.
#   · 끝난 뒤 영어 잔재가 늘거나, 메타 응답이 생기거나, 구조 일치가 떨어지면 그 작품은 git 으로 되돌린다
#     (한도에 걸리면 실패한 씬이 영어로 채워져 오히려 나빠질 수 있다 — 2026-09-29 마션·바빌론).
#   · 로그에 이미 끝난 작품은 건너뛰므로, 끊겨도 같은 명령으로 다시 돌리면 이어서 간다.
#   사용: tools/fix-structure-batch.sh <로그파일> <작품목록파일(한 줄에 하나)>
cd "$(dirname "$0")/.."
LOG="$1"; LIST="$2"
CHECK="$HOME/src-check-clean.py"
C=/Users/hojun/Projects/scriptroom/content
export SRC_CONCURRENCY=3
wait_ok() {
  while true; do
    r=$(curl -s --max-time 120 -X POST localhost:3001/api/translate -H 'Content-Type: application/json' \
        -d '{"formattedText":"# INT. KITCHEN - NIGHT\n\nShe opens the fridge.","work":"probe","guidelines":"자연스러운 한국어로 번역"}')
    echo "$r" | grep -q '냉장고' && return 0
    echo "   (번역 불가 — 대기 $(date '+%m/%d %H:%M')) ${r:0:80}" >> "$LOG"; sleep 600
  done
}
while IFS= read -r w; do
  [ -z "$w" ] && continue
  grep -q "^## $w " "$LOG" 2>/dev/null && continue
  tr=$(ls "$C/$w"/*_translated.txt | head -1)
  wait_ok
  b=$(python3 "$CHECK" "$tr"); read bs _ <<< "$(node tools/struct-match.mjs "$w")"
  node tools/retranslate.mjs "$w" --write --resume --fix-structure >> "$LOG.detail" 2>&1
  node tools/fix-speakers.mjs "$w" --write >> "$LOG.detail" 2>&1
  for t in fix-heading-prefix fix-merged-cues strip-watermark strip-running-header fix-headings fix-cues fix-cue-parens fix-self-correction translate-headings; do
    node tools/$t.mjs "$w" --write >> "$LOG.detail" 2>&1
  done
  a=$(python3 "$CHECK" "$tr"); read as lk <<< "$(node tools/struct-match.mjs "$w")"
  if [ "$a" -gt "$b" ] || [ "$lk" != "0" ] || [ "$as" -lt "$bs" ]; then
    (cd /Users/hojun/Projects/scriptroom && git checkout -- "content/$w/")
    echo "## $w 되돌림 — 구조 $bs→$as% · 잔재 $b→$a · 메타 $lk $(date '+%m/%d %H:%M')" >> "$LOG"
  else
    echo "## $w 완료 — 구조 $bs→$as% · 잔재 $b→$a $(date '+%m/%d %H:%M')" >> "$LOG"
  fi
  node tools/clean-backups.mjs "$w" --write >/dev/null 2>&1
done < "$LIST"
echo "=== 종료 $(date '+%m/%d %H:%M') ===" >> "$LOG"
