// 번역하면서 대사가 통째로 사라졌는지 씬 단위로 검사한다.
//   왜 필요한가: 이중언어 각본에서 '같은 말의 두 벌'을 합치라는 처방이, 짝이 없는 외국어 대사까지
//   버리게 만드는 일이 있다(카산드로: 스페인어만 있고 영어 짝이 없는 대사가 사라짐).
//   처방을 아무리 다듬어도 새로운 이중언어 형태는 계속 나오므로, 처방 대신 '결과'를 본다.
//
//   합쳐지는 게 정상인 만큼은 빼고 센다:
//     - 같은 화자 큐가 연달아 나오는 쌍 = 두 벌 병기 → 하나로 합쳐지는 게 맞다
//   그러고도 모자라면 진짜 손실이다.
//
//   사용: node tools/check-loss.mjs <작품폴더> [--verbose]
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const VERBOSE = process.argv.includes('--verbose')
if (!work) { console.error('사용: node tools/check-loss.mjs <작품폴더> [--verbose]'); process.exit(1) }

const dir = join(CONTENT, work)
if (!existsSync(dir)) { console.error(`폴더 없음: ${work}`); process.exit(1) }
const files = readdirSync(dir)
const fmtF = files.find(f => /_formatted\.txt$/.test(f))
const trF = files.find(f => /_translated\.txt$/.test(f))
if (!fmtF || !trF) { console.error('formatted/translated 없음'); process.exit(1) }

const cueName = s => s.replace(/^@/, '').replace(/\s*\(.*$/, '').trim()

// 씬별로 (대사 수, 합쳐질 쌍 수) 를 센다
function scan(text) {
  const scenes = text.split(/^(?=# )/m)
  return scenes.map(sc => {
    const lines = sc.split('\n').map(l => l.trim())
    const dlg = lines.filter(l => l.startsWith('- ')).length
    const cues = lines.map((l, i) => [i, l]).filter(([, l]) => l.startsWith('@'))
    let pairs = 0
    for (let k = 0; k + 1 < cues.length; k++) {
      const [i, a] = cues[k], [j, b] = cues[k + 1]
      if (cueName(a) === cueName(b) && j - i <= 6) pairs++
    }
    return { head: (lines.find(l => l.startsWith('# ')) || '').slice(0, 46), dlg, pairs }
  })
}

const src = scan(readFileSync(join(dir, fmtF), 'utf8'))
const dst = scan(readFileSync(join(dir, trF), 'utf8'))

// 씬 수가 어긋나면 씬 단위 대조가 무의미하므로 전체 합계로만 본다
if (Math.abs(src.length - dst.length) > Math.max(3, src.length * 0.05)) {
  const S = src.reduce((a, s) => a + s.dlg, 0), D = dst.reduce((a, s) => a + s.dlg, 0)
  const P = src.reduce((a, s) => a + s.pairs, 0)
  console.log(`${work}: 씬 수 불일치(${src.length}→${dst.length}) — 합계로만 검사`)
  console.log(`  대사 ${S} → ${D} · 합쳐질 쌍 ${P} · 손실 추정 ${Math.max(0, S - P - D)}`)
  process.exit(S - P - D > Math.max(3, S * 0.02) ? 7 : 0)
}

let lost = 0
const bad = []
const n = Math.min(src.length, dst.length)
for (let i = 0; i < n; i++) {
  const expected = src[i].dlg - src[i].pairs   // 두 벌 병기가 합쳐진 만큼은 줄어도 정상
  const gap = expected - dst[i].dlg
  if (gap > 0) { lost += gap; bad.push({ i, head: src[i].head, src: src[i].dlg, pairs: src[i].pairs, dst: dst[i].dlg, gap }) }
}

const total = src.reduce((a, s) => a + s.dlg, 0)
console.log(`${work}: 씬 ${src.length} · 원문 대사 ${total} · 번역 대사 ${dst.reduce((a, s) => a + s.dlg, 0)}`)
if (!lost) { console.log('  ✓ 사라진 대사 없음'); process.exit(0) }
console.log(`  ✗ 사라진 것으로 보이는 대사 ${lost}줄 (${bad.length}개 씬)`)
for (const b of (VERBOSE ? bad : bad.slice(0, 6))) {
  console.log(`      씬 ${b.i} ${b.head}`)
  console.log(`         원문 ${b.src} (합쳐질 쌍 ${b.pairs}) → 번역 ${b.dst} · 부족 ${b.gap}`)
}
process.exit(lost > Math.max(3, total * 0.02) ? 7 : 0)
