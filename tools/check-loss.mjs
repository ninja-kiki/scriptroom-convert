// 번역하면서 대사가 통째로 사라졌는지 검사한다.
//
//   ★씬 단위로 짝지어 비교하려는 시도를 두 번 했다가 두 번 다 실패했다.
//     번역기가 씬을 더 만들거나 합치는 일이 흔해서, 한 번 밀리면 그 뒤 전부가
//     '다른 씬끼리' 비교돼 손실로 둔갑한다(완벽했던 비포 선라이즈가 65줄 손실로 나왔다).
//     씬을 내용으로 정렬해 보려 했지만 그 역시 더 큰 오탐을 만들었다.
//     그래서 씬별 위치 추적을 포기하고 '총량'만 본다 — 어디서 사라졌는지는 못 알려주지만,
//     사라졌는지 아닌지는 틀리지 않는다.
//
//   합쳐지는 게 정상인 만큼은 빼고 센다:
//     같은 화자 큐가 연달아 나오는 쌍 = 이중언어 병기 → 하나로 합쳐지는 게 맞다.
//
//   사용: node tools/check-loss.mjs <작품폴더>
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
if (!work) { console.error('사용: node tools/check-loss.mjs <작품폴더>'); process.exit(1) }

const dir = join(CONTENT, work)
if (!existsSync(dir)) { console.error(`폴더 없음: ${work}`); process.exit(1) }
const files = readdirSync(dir)
const fmtF = files.find(f => /_formatted\.txt$/.test(f))
const trF = files.find(f => /_translated\.txt$/.test(f))
if (!fmtF || !trF) { console.error('formatted/translated 없음'); process.exit(1) }

const cueName = s => s.replace(/^@/, '').replace(/\s*\(.*$/, '').trim()

function stat(text) {
  const lines = text.split('\n').map(l => l.trim())
  const dlg = lines.filter(l => l.startsWith('- ')).length
  const scenes = lines.filter(l => l.startsWith('# ')).length
  const cues = lines.map((l, i) => [i, l]).filter(([, l]) => l.startsWith('@'))
  let pairs = 0
  for (let k = 0; k + 1 < cues.length; k++) {
    const [i, a] = cues[k], [j, b] = cues[k + 1]
    if (cueName(a) === cueName(b) && j - i <= 6) pairs++
  }
  // 숫자는 번역돼도 그대로 남는다 — 내용이 실제로 살아있는지 보는 보조 신호
  const nums = new Set((text.match(/\b\d{2,}\b/g) || []))
  return { dlg, scenes, pairs, nums }
}

const S = stat(readFileSync(join(dir, fmtF), 'utf8'))
const D = stat(readFileSync(join(dir, trF), 'utf8'))

const floor = S.dlg - S.pairs          // 이 아래로 내려가면 합치기로 설명이 안 된다
const gap = floor - D.dlg
// 원문에만 있고 번역엔 아예 없는 숫자 — 통째로 빠진 대목이 있는지 보는 보조 지표
const lostNums = [...S.nums].filter(n => !D.nums.has(n))

console.log(`${work}: 씬 ${S.scenes}→${D.scenes} · 대사 ${S.dlg}→${D.dlg} (합쳐질 쌍 ${S.pairs})`)
if (gap > 0) {
  console.log(`  ✗ 대사 ${gap}줄이 설명되지 않는다 — 합치기로는 ${floor}줄까지만 줄어야 한다`)
  if (lostNums.length) console.log(`     원문에만 있는 숫자 ${lostNums.length}개: ${lostNums.slice(0, 8).join(', ')}`)
  process.exit(7)
}
if (lostNums.length > Math.max(8, S.nums.size * 0.25)) {
  console.log(`  ⚠ 대사 수는 맞지만 원문에만 있는 숫자가 ${lostNums.length}/${S.nums.size}개 — 일부 대목이 빠졌을 수 있다`)
  console.log(`     ${lostNums.slice(0, 10).join(', ')}`)
  process.exit(0)
}
console.log('  ✓ 사라진 대사 없음')
