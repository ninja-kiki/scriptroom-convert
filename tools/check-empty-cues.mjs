// 인물 큐만 있고 대사가 없는 자리를 찾는다.
//
//   왜 이 검사인가: 번역본만 읽어서는 무엇이 사라졌는지 알 수 없다. 원문과 대조하지 않으면
//   '없는 것'은 보이지 않기 때문이다. 그런데 각본에는 어길 수 없는 구조가 하나 있다 —
//   인물 큐(@이름)가 나왔으면 그 아래에 그 사람의 대사가 있어야 한다.
//   큐 다음에 바로 다른 큐나 씬 헤딩이 오면, 그 사이에 있던 대사가 사라진 것이다.
//   원문을 안 봐도 결과물만으로 손실을 잡아낼 수 있는, 몇 안 되는 자리다.
//
//   원문(_formatted)에서도 비어 있으면 → 추출 단계에서 날아간 것
//   원문엔 있는데 번역본에서만 비었으면 → 번역 단계에서 날아간 것
//
//   사용: node tools/check-empty-cues.mjs <작품폴더|--all> [--list]
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const LIST = args.includes('--list')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))

// 큐와 대사 사이에 올 수 있는 것: 괄호 지문 '(작게)', 전환 지시 '(CUT TO:)'.
const PAREN = /^\(.*\)$/
function scan(path) {
  const lines = readFileSync(path, 'utf8').split('\n').map(l => l.trimEnd())
  const empty = []
  let cues = 0
  for (let i = 0; i < lines.length; i++) {
    if (!/^@/.test(lines[i])) continue
    cues++
    let j = i + 1
    while (j < lines.length && (!lines[j].trim() || PAREN.test(lines[j].trim()))) j++
    // 대사 줄('- ')이 나와야 정상. 큐/헤딩이 나오거나 파일이 끝나면 대사가 없는 것이다.
    if (j >= lines.length || /^[@#]/.test(lines[j])) empty.push({ n: i + 1, cue: lines[i] })
  }
  return { cues, empty }
}

function pick(dir, re) { try { const f = readdirSync(dir).find(x => re.test(x)); return f ? join(dir, f) : null } catch { return null } }

const list = ALL
  ? readdirSync(CONTENT).filter(n => { if (['scripts','scripts-ocr','posters-bauhaus'].includes(n) || n.startsWith('.')) return false; try { return statSync(join(CONTENT, n)).isDirectory() } catch { return false } })
  : [only]
if (!only && !ALL) { console.error('사용: node tools/check-empty-cues.mjs <작품폴더|--all> [--list]'); process.exit(1) }

for (const w of list) {
  const dir = join(CONTENT, w)
  const fm = pick(dir, /_formatted\.txt$/), tr = pick(dir, /_translated\.txt$/)
  if (!fm && !tr) continue
  const F = fm ? scan(fm) : { cues: 0, empty: [] }
  const T = tr ? scan(tr) : { cues: 0, empty: [] }
  if (!F.empty.length && !T.empty.length) { console.log(`${w}\t${F.cues}\t0\t${T.cues}\t0`); continue }
  console.log(`${w}\t${F.cues}\t${F.empty.length}\t${T.cues}\t${T.empty.length}`)
  if (LIST) {
    for (const e of F.empty.slice(0, 12)) console.log(`    원문 ${e.n}행  ${e.cue.slice(0, 60)}`)
    for (const e of T.empty.slice(0, 12)) console.log(`    번역 ${e.n}행  ${e.cue.slice(0, 60)}`)
  }
}
