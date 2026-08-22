// 화자 표기가 '대사 줄'로 들어간 것을 되돌린다.
//
//   무슨 일인가: '- 내레이터 (V.O.)' 처럼, 누가 말하는지를 적은 줄이 그 사람의 대사로
//   들어가 있다. 리더에서는 화자 이름이 대사 칸에 찍히고, 정작 뒤따르는 진짜 대사는
//   화자 없이 뜬다(아일 오브 독스 59줄, 라이브러리 전체 28편 156줄).
//
//   왜 여태 안 보였나: 검사기는 '한글이 한 글자라도 있으면 통과'시킨다.
//   '- 내레이터 (V.O.)' 에는 한글이 있으므로 영어 잔재로 세지 않았다.
//   영어 잔재가 아니라 구조가 틀린 것이라 그 검사로는 잡을 수 없었다.
//
//   무엇을 근거로 고르나: 줄 전체가 '이름 + 화면 밖 표시' 뿐인 것만.
//   이름 자리에 문장부호(, . ! ? …)가 있으면 대사이므로 건드리지 않는다.
//
//   사용: node tools/fix-cue-as-dialogue.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/fix-cue-as-dialogue.mjs <작품폴더> [--write]'); process.exit(1) }

const CUE = /^-\s*([^,.!?…]{1,22}?)\s*\(\s*(V\.?\s?O\.?|O\.?\s?S\.?|CONT'?D|계속|화면\s*밖|소리|필터|F|E|OFF)([^)]*)\)\s*$/i

const dir = join(CONTENT, work)
let total = 0
for (const kind of ['_formatted.txt', '_translated.txt']) {
  const file = readdirSync(dir).find(f => f.endsWith(kind))
  if (!file) continue
  const path = join(dir, file)
  const lines = readFileSync(path, 'utf8').split('\n')
  let n = 0
  const out = lines.map(l => {
    const m = l.trim().match(CUE)
    if (!m) return l
    // 이름 앞에 '@'가 한 번 더 붙어 오기도 한다('- @디어드리 (CONT'D)')
    const name = m[1].replace(/^@+/, '').trim()
    if (!name) return l
    n++
    return `@${name} (${m[2]}${m[3]})`
  })
  if (!n) { console.log(`  ${kind}: 없음`); continue }
  console.log(`  ${kind}: ${n}줄 복구`)
  total += n
  if (WRITE) {
    if (!existsSync(path + '.cdbak')) copyFileSync(path, path + '.cdbak')
    writeFileSync(path, out.join('\n'))
  }
}
if (!WRITE && total) console.log('  (--write 없음 — 저장 안 함)')
