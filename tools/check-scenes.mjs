// 씬 나눔이 수상한 작품만 골라낸다 — 매번 LLM을 부르지 않기 위한 1차 관문.
//
//   지금까지 대부분의 각본은 규칙만으로 잘 나뉘었다. 그러니 전부를 LLM에 태울 이유가 없다.
//   다만 INT./EXT. 를 안 쓰거나 시간 표시를 안 붙이는 각본(TÁR)은 헤딩이 통째로 안 잡혀
//   한 씬이 2만 자를 넘긴다. 그런 것만 골라 LLM 판정(review-scenes.mjs)으로 넘긴다.
//
//   기준은 라이브러리 실측에서 뽑았다:
//     씬 길이 중앙값의 중앙값 593자 · 평균 씬 길이는 대개 1,000~2,000자
//     TÁR 4,822자 · the-favourite 6,019자 · kimi 6,173자 — 확연히 다른 무리
//
//   사용: node tools/check-scenes.mjs <작품폴더|--all>
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))
if (!ALL && !only) { console.error('사용: node tools/check-scenes.mjs <작품폴더|--all>'); process.exit(1) }

// 평균 씬 길이가 이 값을 넘으면 '헤딩을 놓쳤을 수 있다'고 본다.
//   정상 무리의 두 배 남짓. 길게 쓰는 각본을 억울하게 걸지 않으면서 TÁR 류는 잡는다.
const AVG_LIMIT = 3200
// 한 씬이 이만큼 길면, 평균이 정상이어도 그 씬 하나는 들여다볼 값어치가 있다.
const MAX_LIMIT = 20000

function inspect(w) {
  const dir = join(CONTENT, w)
  let files
  try { files = readdirSync(dir) } catch { return null }
  const f = files.find(x => /_formatted\.txt$/.test(x))
  if (!f) return null
  const t = readFileSync(join(dir, f), 'utf8')
  const scenes = t.split(/^(?=# )/m).filter(s => s.trim())
  if (scenes.length < 2) return { w, scenes: scenes.length, avg: t.length, max: t.length, why: '씬이 사실상 없음' }
  const lens = scenes.map(s => s.length)
  const avg = Math.round(t.length / scenes.length)
  const max = Math.max(...lens)

  // 놓쳤을 법한 헤딩 후보 — 씬 본문 안에 든 짧은 대문자 독립 줄
  let cand = 0
  for (const l of t.split('\n')) {
    const s = l.trim()
    if (!s || /^[#@(]/.test(s) || s.startsWith('- ') || s.length > 70) continue
    const L = s.replace(/[^A-Za-z]/g, ''), U = s.replace(/[^A-Z]/g, '')
    if (L.length >= 4 && U.length / L.length >= 0.85) cand++
  }

  const why = []
  if (avg > AVG_LIMIT) why.push(`평균 씬 ${avg.toLocaleString()}자`)
  if (max > MAX_LIMIT) why.push(`최대 씬 ${max.toLocaleString()}자`)
  if (cand > scenes.length) why.push(`씬 안의 대문자 독립줄 ${cand}개 > 씬 수 ${scenes.length}`)
  return { w, scenes: scenes.length, avg, max, cand, why: why.join(' · ') }
}

const works = ALL ? readdirSync(CONTENT).filter(d => !['scripts', 'scripts-ocr', 'posters-bauhaus'].includes(d)) : [only]
const flagged = []
for (const w of works) {
  const r = inspect(w)
  if (!r) continue
  if (r.why) flagged.push(r)
  else if (!ALL) console.log(`${w}: 씬 ${r.scenes} · 평균 ${r.avg.toLocaleString()}자 — 이상 없음`)
}
if (flagged.length) {
  console.log(`씬 나눔이 수상한 작품 ${flagged.length}편 — LLM 판정 권장:`)
  for (const r of flagged.sort((a, b) => b.avg - a.avg))
    console.log(`  ${r.w.padEnd(36)} 씬 ${String(r.scenes).padStart(4)} · ${r.why}`)
  console.log(`\n  → node tools/review-scenes.mjs <작품> 으로 판정`)
} else if (ALL) console.log('수상한 작품 없음')
