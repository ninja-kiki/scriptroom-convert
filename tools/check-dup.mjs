// content/ 안의 작품 폴더 중 같은 작품인데 다른 이름으로 중복 생성된 게 있는지 훑는다.
//
//   scriptroom(라이브러리 앱)이 폴더명(=작품 id)으로 작품을 식별한다. 판본 낱말이나
//   연도 유무가 갈리면 같은 작품이 다른 작품으로 인식된다 — 실제로 127hours/127-hours-2010,
//   Roma/roma-2018, amour/Amour(2012), The Wrestler - Release/the-wrestler 에서 겪었다.
//
//   비교 키: 확장자·판본 낱말(release/final/draft/script 등)을 걷어내고, 영숫자만 남긴 뒤,
//   끝의 연도를 뗀다. src-batch61-parallel.sh 의 normkey() 와 같은 규칙 — 배치가 새 폴더를
//   만들 때 쓰는 판정과 이 도구가 사후에 훑을 때 쓰는 판정이 갈리면 안 되므로 로직을 맞췄다.
//
//   사용: node tools/check-dup.mjs [--write]
//   --write 없이는 후보만 보여준다. --write 를 주면 둘 중 번역이 더 진행된(잔재 더 적은,
//   같으면 씬 수가 더 많은) 쪽을 남기고, 나머지 폴더의 PDF/자료를 그쪽으로 옮긴 뒤
//   빈 폴더를 지운다 — 두 폴더 다 절반쯤 번역돼 있으면 자동으로 못 고르니 후보만 낸다.
import { readdirSync, statSync, existsSync, renameSync, rmdirSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const CHECKER = '/Users/hojun/src-check-clean.py'
const WRITE = process.argv.includes('--write')
const SKIP = new Set(['scripts', 'scripts-ocr', 'posters-bauhaus'])

function normkey(name) {
  let s = name
  s = s.replace(/\.(pdf|PDF|rtf|txt|docx|fdx)$/, '')
  s = s.toLowerCase()
  s = s.replace(/(release|final|draft|shooting[ _-]?script|shootingscript|revised|revision|script|screenplay|fdx)/g, '')
  s = s.replace(/[^a-z0-9]/g, '')
  s = s.replace(/(19|20)\d{2}$/, '')
  return s
}

const dirs = readdirSync(CONTENT).filter(n => {
  if (SKIP.has(n) || n.startsWith('.')) return false
  try { return statSync(join(CONTENT, n)).isDirectory() } catch { return false }
})

const byKey = new Map()
for (const d of dirs) {
  const k = normkey(d)
  if (!k) continue
  if (!byKey.has(k)) byKey.set(k, [])
  byKey.get(k).push(d)
}

const groups = [...byKey.values()].filter(g => g.length > 1)
if (!groups.length) { console.log('중복 없음'); process.exit(0) }

function residue(dir) {
  try {
    const f = readdirSync(join(CONTENT, dir)).find(x => x.endsWith('_translated.txt'))
    if (!f) return Infinity
    const out = execFileSync('python3', [CHECKER, join(CONTENT, dir, f)], { encoding: 'utf8' }).trim()
    return parseInt(out, 10) || 0
  } catch { return Infinity }
}
function sceneCount(dir) {
  try {
    const f = readdirSync(join(CONTENT, dir)).find(x => x.endsWith('_translated.txt'))
    if (!f) return 0
    const txt = execFileSync('grep', ['-c', '^# ', join(CONTENT, dir, f)], { encoding: 'utf8' }).trim()
    return parseInt(txt, 10) || 0
  } catch { return 0 }
}

console.log(`중복 후보 ${groups.length}그룹`)
for (const g of groups) {
  console.log(`\n· ${g.join('  ↔  ')}`)
  const scored = g.map(d => ({ d, res: residue(d), scenes: sceneCount(d) }))
  for (const s of scored) console.log(`    ${s.d}: 잔재 ${s.res === Infinity ? '번역없음' : s.res + '줄'} · 씬 ${s.scenes}`)
  if (!WRITE) continue

  scored.sort((a, b) => a.res - b.res || b.scenes - a.scenes)
  const keep = scored[0], rest = scored.slice(1)
  if (keep.res === Infinity) { console.log('    → 둘 다 번역 없음, 자동 병합 보류'); continue }
  const ambiguous = rest.some(r => r.res !== Infinity && r.res < Infinity)
  if (ambiguous) { console.log('    → 여러 폴더가 다 번역돼 있음, 자동 병합 보류(사람이 골라야 함)'); continue }

  for (const r of rest) {
    const from = join(CONTENT, r.d), to = join(CONTENT, keep.d)
    for (const f of readdirSync(from)) {
      if (f.toLowerCase().endsWith('.pdf')) {
        const dest = join(to, f)
        if (existsSync(dest)) unlinkSync(join(from, f))
        else renameSync(join(from, f), dest)
      }
    }
    const left = readdirSync(from)
    if (!left.length) { rmdirSync(from); console.log(`    → '${r.d}' PDF만 옮기고 빈 폴더 삭제, '${keep.d}' 유지`) }
    else console.log(`    → '${r.d}' 에 PDF 외 파일이 남아있어 폴더는 안 지움: ${left.join(', ')}`)
  }
}
if (!WRITE) console.log('\n(--write 없음 — 병합 안 함)')
