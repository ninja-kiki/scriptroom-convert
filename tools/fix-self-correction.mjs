import { atomicWrite } from './_atomic-write.mjs'
// 번역기가 '스스로 고쳐 쓴' 흔적을 정리한다.
//
//   무슨 일이 있었나: 씬 하나를 번역하다가 원문을 그대로 옮겨 적고는, 도중에 알아채고
//   "Wait — that's the source. Here is the translation:" 이라 쓴 뒤 다시 번역했다(리플리).
//   뒤쪽 번역은 멀쩡하다. 앞의 원문 덩어리와 그 알림 줄만 버리면 된다.
//
//   왜 지우는 자리를 '씬 머리까지'로 잡나: 다시 쓰기는 그 씬을 처음부터 다시 한 것이므로,
//   버려야 할 범위는 '알림 줄이 속한 씬의 시작'부터다. 그 앞 씬은 건드리지 않는다.
//
//   찾는 기준은 '번역 결과가 아니라 번역기가 독자에게 건네는 말'이다 —
//   각본 본문에는 이런 말이 나올 수 없다.
//
//   사용: node tools/fix-self-correction.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/fix-self-correction.mjs <작품폴더> [--write]'); process.exit(1) }

const CUE = [
  /that'?s the source/i,
  /here is the (correct )?translation/i,
  /(다시|올바른) 번역(하면|은|입니다)/,
  /^(wait|sorry|apolog|oops)\b[^가-힣]*$/i,
]

const dir = join(CONTENT, work)
const file = readdirSync(dir).find(f => f.endsWith('_translated.txt'))
if (!file) { console.error('번역본 없음'); process.exit(1) }
const path = join(dir, file)
const lines = readFileSync(path, 'utf8').split('\n')

const drop = new Set()
let found = 0
for (let i = 0; i < lines.length; i++) {
  const s = lines[i].trim()
  if (!s || !CUE.some(re => re.test(s))) continue
  // 알림 줄이 속한 씬의 시작을 찾아 거기서부터 알림 줄까지 버린다
  let start = i
  while (start > 0 && !lines[start].startsWith('# ')) start--
  for (let j = start; j <= i; j++) drop.add(j)
  found++
  console.log(`  ${start + 1}–${i + 1}행 버림 (${i - start + 1}줄) — "${s.slice(0, 60)}"`)
}

if (!found) { console.log('  스스로 고쳐 쓴 흔적 없음'); process.exit(0) }

const out = lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n')
console.log(`  ${found}곳 · 씬 ${lines.filter(l => l.startsWith('# ')).length} → ${out.split('\n').filter(l => l.startsWith('# ')).length}`)
if (!WRITE) { console.log('  (--write 없음 — 저장 안 함)'); process.exit(0) }
if (!existsSync(path + '.scbak')) copyFileSync(path, path + '.scbak')
atomicWrite(path, out)
console.log('  ✓ 저장')
