// 원문(EN)·번역(KO) 씬이 실제로 밀려 있는지 확인한다 — 씬 개수만 다르다고 다 문제는 아니다.
//
//   씬 개수 차이는 두 갈래다.
//     · 무해함: 원문 마지막에 씬이 하나 더/덜 붙어서 그 뒤로 밀릴 게 없다.
//     · 진짜 문제: 어딘가에서 씬 하나가 통째로 중복 번역돼, 그 지점부터
//       끝까지 EN/KO 짝이 한 칸씩 밀린다(센티멘탈 밸류가 이 경우였다 — 197/196,
//       '2층으로 가는 계단'이 두 번 번역돼 후반 3분의 2가 전부 밀렸다).
//
//   밀렸는지는 어떻게 아나: 헤딩에 우연히 들어간 숫자(연도·씬번호·시각)는
//   번역해도 안 바뀐다. 그 숫자들이 원문·번역에서 같은 순서로 나오는지,
//   그리고 그 사이의 '위치 차이(오프셋)'가 끝까지 하나로 유지되는지 본다.
//   오프셋이 파일 끝까지 그대로면(0이든 다른 값이든) 밀린 게 아니라 처음부터
//   그 값이었던 것 — 예: 진짜로 씬 하나가 더 있는 채로 시작해서 끝까지 그런 것.
//   오프셋이 도중에 바뀌면 그 지점부터 진짜로 밀린 것이다.
//
//   사용: node tools/check-scene-align.mjs <작품폴더>
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
if (!work) { console.error('사용: node tools/check-scene-align.mjs <작품폴더>'); process.exit(1) }
const dir = join(CONTENT, work)
const ff = readdirSync(dir).find(f => f.endsWith('_formatted.txt'))
const tf = readdirSync(dir).find(f => f.endsWith('_translated.txt'))
if (!ff || !tf) { console.error('formatted/translated 없음'); process.exit(1) }

// ★원문 자체에 내용 없는 헤딩이 섞여 있을 수 있다('# T' 같은 PDF 추출 잡음, ferrari-2023에 6개).
//   그런 건 번역본에 대응이 없는 게 정상이므로, 헤딩 개수를 셀 때부터 뺀다.
//   안 그러면 '번역이 몇 개 부족하다'는 착시가 생긴다.
function heads(p, skipEmpty) {
  const lines = readFileSync(join(dir, p), 'utf8').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('# ')) continue
    if (skipEmpty) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && lines[j].startsWith('# ')) continue  // 원문 쪽 빈 헤딩(예: 'T' 같은 추출 잡음)은 건너뛴다
    }
    out.push(lines[i].trim())
  }
  return out
}
// 번역본 쪽은 빈 헤딩을 그대로 센다 — 그게 바로 찾아야 할 유령 씬이다.
const f = heads(ff, true), t = heads(tf, false)
const nums = (s) => (s.replace(/\s/g, '').match(/\d{2,4}/g) || []).join(',')

const fi = f.map((s, i) => [i, nums(s)]).filter(([, n]) => n)
const ti = t.map((s, i) => [i, nums(s)]).filter(([, n]) => n)

let offsets = []
const len = Math.min(fi.length, ti.length)
for (let k = 0; k < len; k++) {
  if (fi[k][1] !== ti[k][1]) { console.log(`${work}: 숫자 자체가 어긋남 — 앵커로 못 씀 (씬${fi[k][0] + 1} "${fi[k][1]}" vs 씬${ti[k][0] + 1} "${ti[k][1]}")`); process.exit(0) }
  offsets.push(ti[k][0] - fi[k][0])
}
const distinct = [...new Set(offsets)]
const changes = offsets.filter((o, i) => i === 0 || o !== offsets[i - 1]).length

console.log(`${work}: 원문 ${f.length}씬 · 번역 ${t.length}씬 · 숫자 앵커 ${len}개 · 오프셋 종류 ${distinct.length}개(${distinct.join(',')}) · 전환 ${changes - 1}회`)
if (distinct.length > 1) {
  let prev = offsets[0]
  for (let k = 1; k < offsets.length; k++) {
    if (offsets[k] !== prev) {
      console.log(`  ⚠ 씬${fi[k][0] + 1}부터 오프셋 ${prev}→${offsets[k]} — 이 지점부터 뒤가 밀렸을 수 있음`)
      prev = offsets[k]
    }
  }
}
