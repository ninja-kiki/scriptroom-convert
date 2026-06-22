// 검수 질문지 — 변환에서 애매한 케이스만 모아 사람에게 1회 질문, 답 받아 적용.
//   생성: node tools/review.mjs --gen <작품폴더명>     → content/<작품>/_review.txt 만듦
//   적용: node tools/review.mjs --apply <작품폴더명>   → 표시한 답대로 교정 후 재정렬
// 질문 종류: ① @ 라벨이 인물 맞는지 (저빈도=불확실) ② 영어로 남은 줄 유지/번역
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
const DIR = '/Users/hojun/Projects/scriptroom/content'
const SRC = '/Users/hojun/Projects/scriptroom-convert-local'

const mode = process.argv[2]            // --gen | --apply
const work = process.argv[3]
if (!work || !['--gen', '--apply'].includes(mode)) { console.error('사용: node tools/review.mjs --gen|--apply <작품>'); process.exit(1) }
const dir = join(DIR, work)
const ff = readdirSync(dir).find(f => /_formatted\.txt$/.test(f))
const tf = readdirSync(dir).find(f => /_translated\.txt$/.test(f))
const reviewPath = join(dir, '_review.txt')
const enText = readFileSync(join(dir, ff), 'utf8')
const koText = readFileSync(join(dir, tf), 'utf8')
const hasHangul = (s) => /[가-힣]/.test(s)

if (mode === '--gen') {
  // ① 저빈도(≤2회) @ 라벨 — 인물인지 불확실
  const cueCount = {}
  for (const l of enText.split('\n')) { const t = l.trim(); if (t.startsWith('@')) { const c = t.slice(1).replace(/\s*\(.*\)\s*$/, '').trim(); cueCount[c] = (cueCount[c] || 0) + 1 } }
  const lowCues = Object.entries(cueCount).filter(([, n]) => n <= 2).map(([c]) => c).sort()
  // ② 영어로 남은 대사/지문 줄 (한글 없음, dedup, 마커·전환 제외)
  const engSet = new Set()
  for (const l of koText.split('\n')) { const t = l.trim(); if (t && !/^[#@(]/.test(t) && !hasHangul(t) && /[A-Za-z]{2,}/.test(t) && !/^(CUT TO|FADE|DISSOLV|INTERCUT|BACK TO)/i.test(t)) engSet.add(t.slice(0, 80)) }
  const engs = [...engSet].sort()

  const lines = []
  lines.push(`# 검수 질문지 — ${work}`)
  lines.push(`# 표시법: 아래 설명대로 줄 맨 앞에 글자만 적으면 됨. 저장 후 --apply 실행.`)
  lines.push('')
  lines.push(`## ① 이 @ 라벨이 인물(화자)이 아니면 맨 앞에 "x" — 인물이면 그대로 두기`)
  lines.push(`##   (1~2번만 나온 라벨이라 단역일 수도, 장소·지시 오탐일 수도)`)
  for (const c of lowCues) lines.push(`  ${c}`)
  lines.push('')
  lines.push(`## ② 영어로 남은 줄 — 번역하려면 맨 앞에 "t", 그대로 둘 거면(외국어·사인 등) 그대로`)
  for (const e of engs) lines.push(`  ${e}`)
  lines.push('')
  writeFileSync(reviewPath, lines.join('\n'))
  console.log(`→ ${reviewPath}`)
  console.log(`  ① 저빈도 @ 라벨 ${lowCues.length}개 · ② 영어 잔존 ${engs.length}개`)
  console.log(`  파일 열어서 표시 → node tools/review.mjs --apply ${work}`)
}

if (mode === '--apply') {
  if (!existsSync(reviewPath)) { console.error('_review.txt 없음 — 먼저 --gen 하세요'); process.exit(1) }
  const rl = readFileSync(reviewPath, 'utf8').split('\n')
  const demote = new Set(), translate = new Set()
  let sec = 0
  for (const raw of rl) {
    if (/^## ①/.test(raw)) { sec = 1; continue }
    if (/^## ②/.test(raw)) { sec = 2; continue }
    if (/^#/.test(raw) || !raw.trim()) continue
    const m = raw.match(/^\s*([xt]?)\s+(.*)$/i)
    if (!m) continue
    const [, flag, body] = m
    if (sec === 1 && /x/i.test(flag)) demote.add(body.trim())
    if (sec === 2 && /t/i.test(flag)) translate.add(body.trim())
  }
  console.log(`적용: @ 강등 ${demote.size}개 · 번역 지정 ${translate.size}개`)
  // ① @ 강등: 해당 라벨로 시작하는 @줄을 EN/KO 양쪽에서 @ 떼고 지문화
  const stripCue = (text) => text.split('\n').map(l => {
    const t = l.trim()
    if (!t.startsWith('@')) return l
    const c = t.slice(1).replace(/\s*\(.*\)\s*$/, '').trim()
    return demote.has(c) ? l.replace(/^(\s*)@\s*/, '$1') : l
  }).join('\n')
  writeFileSync(join(dir, ff), stripCue(enText))
  writeFileSync(join(dir, tf), stripCue(koText))
  // ② 번역 지정 줄: 임시 마커로 표시 → realign 갭필이 채우게 (간단히: 그냥 영어로 두면 needsTranslation이 잡아 번역)
  //    (translate 셋은 이미 needsTranslation 대상이라 realign --gapfill만 돌리면 채워짐)
  console.log('재정렬+갭필 실행...')
  execSync(`node tools/realign.mjs --write --overwrite --gapfill --model=claude-opus-4-8 --only=${work}`, { cwd: SRC, stdio: 'inherit' })
  console.log('완료. (검수 질문지 _review.txt는 보관 또는 삭제)')
}
