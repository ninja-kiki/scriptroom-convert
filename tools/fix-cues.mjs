// 번역본에 영어로 남은 인물 큐(@NAME)를 한글로 바꾼다 — LLM 없이, 같은 작품 안의 정보만으로.
//   원리: formatted(영어)와 translated의 큐는 같은 순서로 1:1 대응한다.
//         그 쌍에서 'ENGLISH → 한글' 사전을 자동으로 만들고, 아직 영어인 큐에 적용한다.
//   사용: node tools/fix-cues.mjs <작품폴더> [--write]
//
// 안전 원칙: 사전에 없는 이름은 절대 손대지 않는다(추측 치환 금지).
//   V.O./O.S./CONT'D 같은 수식어는 영어 그대로 유지한다.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/fix-cues.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const files = readdirSync(dir)
const fmtFile = files.find(f => /_formatted\.txt$/.test(f))
const trFile = files.find(f => /_translated\.txt$/.test(f))
if (!fmtFile || !trFile) { console.error('formatted/translated 없음'); process.exit(1) }

const trPath = join(dir, trFile)
const fmtLines = readFileSync(join(dir, fmtFile), 'utf8').split('\n')
const trLines = readFileSync(trPath, 'utf8').split('\n')

const cueOf = ls => ls.map(l => l.trim()).filter(s => s.startsWith('@'))
const fmtCues = cueOf(fmtLines)
const trCues = cueOf(trLines)

// 이름 부분만 분리 (수식어 괄호 제외)
const SUFFIX = /\s*\((V\.?O\.?|O\.?S\.?|CONT['’]?D|CONTD|MORE|CONTINUED|PRE-?LAP|OVER RADIO|OVER COMMS|ON PHONE|filtered)[^)]*\)\s*$/i
const splitCue = s => {
  const body = s.replace(/^@/, '')
  const m = body.match(SUFFIX)
  return { name: (m ? body.slice(0, m.index) : body).trim(), suffix: m ? m[0].trim() : '' }
}

// 위치 대응으로 사전 만들기.
//   큐 개수가 몇 개 어긋나는 건 흔한데(추출 드리프트), 그때마다 통째로 포기하면 사전을 못 만든다.
//   두 포인터로 훑으며 '영어 원본 ↔ 한글 번역' 쌍만 모으고, 어긋나는 자리는 건너뛴다.
//   같은 영어 이름이 서로 다른 한글로 관측되면 애매하므로 후보에서 제외한다(추측 치환 금지).
const votes = new Map()   // EN -> Map(KO -> count)
{
  let i = 0, j = 0
  while (i < fmtCues.length && j < trCues.length) {
    const en = splitCue(fmtCues[i]).name
    const ko = splitCue(trCues[j]).name
    if (!en || !ko) { i++; j++; continue }
    if (/[가-힣]/.test(en)) { i++; j++; continue }
    if (/[가-힣]/.test(ko)) {
      if (!votes.has(en)) votes.set(en, new Map())
      const m = votes.get(en)
      m.set(ko, (m.get(ko) || 0) + 1)
    }
    i++; j++
  }
}
const dict = new Map()
for (const [en, m] of votes) {
  const sorted = [...m].sort((a, b) => b[1] - a[1])
  const [top, topN] = sorted[0]
  const second = sorted[1]?.[1] || 0
  // 압도적으로 우세할 때만 채택 — 갈리면 쓰지 않는다
  if (topN >= 2 && topN >= second * 3) dict.set(en, top)
  else if (sorted.length === 1 && topN >= 1) dict.set(en, top)
}

let changed = 0, skipped = new Set()
const out = trLines.map(l => {
  const s = l.trim()
  if (!s.startsWith('@')) return l
  const { name, suffix } = splitCue(s)
  if (!name || /[가-힣]/.test(name)) return l
  const ko = dict.get(name)
  if (!ko) { skipped.add(name); return l }
  changed++
  return '@' + ko + (suffix ? ' ' + suffix : '')
})

console.log(`${work}: 사전 ${dict.size}개 · 치환 ${changed}개 · 미매칭 ${skipped.size}종`)
if (skipped.size) console.log(`   미매칭 예: ${[...skipped].slice(0, 5).join(', ')}`)
if (WRITE && changed) {
  if (!existsSync(trPath + '.cuebak')) copyFileSync(trPath, trPath + '.cuebak')
  writeFileSync(trPath, out.join('\n'))
  console.log(`  ✓ 저장 (백업: .cuebak)`)
} else if (!WRITE) {
  console.log('  (--write 없음 — 저장 안 함)')
}
