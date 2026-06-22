// 한국어 번역본(_translated.txt) 씬 헤딩의 INT./EXT. 접두어 → 내부/외부 로 통일.
// 영문 원문(_formatted.txt)은 안 건드림. # 로 시작하는 헤딩 줄만, 접두어만 치환 (장소/시간은 그대로).
// 결정적 치환 · 토큰 0. 사용: node tools/normalize-headings.mjs [--dir=...] [--write]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const DIR = (args.find(a => a.startsWith('--dir=')) || '').slice(6) || '/Users/hojun/Projects/scriptroom/content'

// 순서 중요: 복합형(INT./EXT.) 먼저
const RULES = [
  [/^(#\s*)INT\.\/EXT\./i, '$1내부./외부.'],
  [/^(#\s*)EXT\.\/INT\./i, '$1외부./내부.'],
  [/^(#\s*)I\/E\./i, '$1내부./외부.'],
  [/^(#\s*)INT\./i, '$1내부.'],
  [/^(#\s*)EXT\./i, '$1외부.'],
]

function normalize(text) {
  let changed = 0
  const out = text.split('\n').map(line => {
    if (!line.startsWith('#')) return line
    for (const [re, rep] of RULES) {
      if (re.test(line)) { changed++; return line.replace(re, rep) }
    }
    return line
  })
  return { text: out.join('\n'), changed }
}

let totalChanged = 0, works = 0
for (const w of readdirSync(DIR)) {
  const dir = join(DIR, w)
  try { if (!statSync(dir).isDirectory()) continue } catch { continue }
  const tf = readdirSync(dir).find(f => /_translated\.txt$/.test(f))
  if (!tf) continue
  const path = join(dir, tf)
  const { text, changed } = normalize(readFileSync(path, 'utf8'))
  if (changed > 0) {
    console.log(`- ${w}: 헤딩 ${changed}개 통일`)
    totalChanged += changed; works++
    if (WRITE) writeFileSync(path, text)
  }
}
console.log(`\n${works}편 · 총 ${totalChanged}개 헤딩 ${WRITE ? '통일 완료' : '(미리보기 — --write로 적용)'}`)
