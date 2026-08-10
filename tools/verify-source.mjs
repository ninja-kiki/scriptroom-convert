// 번역에 들어가기 전에 formatted(원문 구조)가 쓸 만한지 판정한다.
//   왜 필요한가: 지금까지 '청소'(clean-ocr)는 있었지만 '검증'이 없었다.
//   스캔 PDF를 OCR하면 대사가 통째로 빠지거나 두 화자 말이 한 덩어리로 붙는데,
//   번역기는 그걸 그대로 옮긴다. 결과물에는 틀렸다는 표시가 남지 않아서
//   읽는 사람은 원래 그런 각본인 줄 안다 — 그래서 번역 전에 걸러야 한다.
//
//   사용: node tools/verify-source.mjs <작품폴더|파일경로> [--strict]
//   종료코드: 0 정상 · 5 경고(--strict 일 때만 실패로 취급) · 6 심각
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const arg = process.argv[2]
const STRICT = process.argv.includes('--strict')
if (!arg) { console.error('사용: node tools/verify-source.mjs <작품폴더|파일> [--strict]'); process.exit(1) }

let path = arg
if (!existsSync(path)) {
  const dir = join(CONTENT, arg)
  const f = existsSync(dir) && readdirSync(dir).find(x => /_formatted\.txt$/.test(x))
  if (!f) { console.error(`formatted 없음: ${arg}`); process.exit(1) }
  path = join(dir, f)
}

const lines = readFileSync(path, 'utf8').split('\n')
const trimmed = lines.map(l => l.trim())
const scenes = trimmed.filter(l => l.startsWith('# '))
const cues = trimmed.filter(l => l.startsWith('@'))
const dlgs = trimmed.filter(l => l.startsWith('- '))

const issues = []   // {level: 'warn'|'bad', msg, sample}

// ① 대사 없는 화자 큐 — OCR이 대사 줄을 통째로 놓친 신호
let emptyCues = 0
const emptySample = []
for (let i = 0; i < trimmed.length; i++) {
  if (!trimmed[i].startsWith('@')) continue
  // 큐 다음에 오는 '내용 있는 줄' 3개 안에 대사가 없으면 빈 큐로 본다.
  //   ★빈 줄을 세면 안 된다 — formatted 는 블록 사이가 빈 줄이라
  //   '큐 → 빈줄 → (괄호 지문) → 빈줄 → 대사'가 정상인데 그걸 전부 누락으로 잡았다.
  const near = []
  for (let j = i + 1; j < trimmed.length && near.length < 3; j++) {
    if (!trimmed[j]) continue
    near.push(trimmed[j])
    if (trimmed[j].startsWith('@') || trimmed[j].startsWith('# ')) break   // 다음 블록으로 넘어갔다
  }
  if (!near.some(l => l.startsWith('- '))) {
    emptyCues++
    if (emptySample.length < 3) emptySample.push(`${i + 1}: ${trimmed[i]}`)
  }
}
const emptyRatio = cues.length ? emptyCues / cues.length : 0
if (emptyRatio > 0.03) issues.push({ level: emptyRatio > 0.08 ? 'bad' : 'warn', msg: `대사 없는 화자 큐 ${emptyCues}개 (${(emptyRatio * 100).toFixed(1)}%)`, sample: emptySample })

// ② OCR 쓰레기 줄 — 알파벳은 있는데 '영어 단어처럼 생기지 않은' 토큰이 몰린 줄
//    (clean-ocr 는 '3글자 이상 단어가 있으면 진짜'로 봐서 이런 줄을 놓쳤다)
const looksFake = w => {
  const s = w.replace(/[^A-Za-z]/g, '')
  if (s.length < 3) return false
  // 의성어·늘여 쓴 말(Shhh, Sssss, Hmmm, YESSS)은 모음이 없어도 정상이다
  if (/(.)\1{2,}/i.test(s)) return false
  if (!/[aeiouAEIOU]/.test(s)) return true                 // 모음 없음
  if (/[bcdfghjklmnpqrstvwxz]{4,}/i.test(s)) return true   // 자음 4연속
  if (/[A-Za-z][0-9]|[0-9][A-Za-z]/.test(w)) return true   // 글자·숫자 뒤섞임(l→1, O→0)
  return false
}
let junk = 0
const junkSample = []
for (let i = 0; i < trimmed.length; i++) {
  const s = trimmed[i].replace(/^[-@#]\s*/, '')
  const words = s.split(/\s+/).filter(w => /[A-Za-z]/.test(w))
  if (words.length < 4) continue
  const fake = words.filter(looksFake).length
  if (fake / words.length > 0.5) {
    junk++
    if (junkSample.length < 3) junkSample.push(`${i + 1}: ${s.slice(0, 60)}`)
  }
}
if (junk) issues.push({ level: junk > 5 ? 'bad' : 'warn', msg: `OCR 쓰레기로 보이는 줄 ${junk}개`, sample: junkSample })

// ③ 씬 헤딩 오인식 — INT/EXT 를 잘못 읽은 꼴(INI, 1NT, EXI, FXT)만 잡는다.
//   ★'# AN OUT OF FOCUS BINOCULAR POV - DUSK', '# BACK IN "THE CAVE"', '# SIGN SPINNER UNIVERSE:'
//     같은 비표준 슬러그 헤딩은 각본에서 정상이다. 앞머리가 짧은 대문자라는 이유로 잡으면 안 된다.
//   그래서 'INT/EXT 와 한 글자 차이인 것'만 오인식으로 본다.
const near1 = (a, b) => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d === 1
}
const badHead = scenes.filter(s => {
  const m = s.match(/^#\s+([A-Z0-9]{3})\b/)
  if (!m) return false
  const head = m[1]
  if (head === 'INT' || head === 'EXT') return false
  return near1(head, 'INT') || near1(head, 'EXT')
})
if (badHead.length) issues.push({ level: badHead.length > 3 ? 'bad' : 'warn', msg: `헤딩 앞머리가 INT/EXT 가 아닌 것 ${badHead.length}개(OCR 오인식 의심)`, sample: badHead.slice(0, 3) })

// ④ 화자명 난립 — 같은 인물이 철자 하나 차이로 갈린 경우(FREDDIE / FREDD1E)
const names = {}
for (const c of cues) {
  const n = c.replace(/^@/, '').split('(')[0].trim()
  if (n) names[n] = (names[n] || 0) + 1
}
const keys = Object.keys(names)
const variants = []
for (const a of keys) {
  if (names[a] > 3) continue                    // 자주 나오는 이름은 정본으로 본다
  for (const b of keys) {
    if (a === b || names[b] < 5) continue
    if (a.length !== b.length || a.length < 4) continue
    // ★번호만 다른 단역(COP 1 / COP 9, MAN 2 / MAN 3)은 서로 다른 인물이다 — 변형이 아니다.
    if (a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#')) continue
    let d = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
    if (d === 1) { variants.push(`${a}(${names[a]}) ↔ ${b}(${names[b]})`); break }
  }
}
if (variants.length) issues.push({ level: variants.length > 5 ? 'bad' : 'warn', msg: `화자명 철자 변형 ${variants.length}쌍`, sample: variants.slice(0, 3) })

// ⑤ 대사가 지나치게 긴 것 — 두 사람 말이 한 덩어리로 붙은 신호
const longDlg = dlgs.filter(d => d.length > 600)
if (longDlg.length) issues.push({ level: longDlg.length > 10 ? 'bad' : 'warn', msg: `600자 넘는 대사 ${longDlg.length}개(화자 병합 의심)`, sample: longDlg.slice(0, 2).map(d => d.slice(0, 60) + '…') })

// ⑥ 구조 자체가 성립하는지
if (scenes.length < 5) issues.push({ level: 'bad', msg: `씬이 ${scenes.length}개뿐 — 헤딩 인식 실패`, sample: [] })
if (cues.length < 10) issues.push({ level: 'bad', msg: `화자 큐가 ${cues.length}개뿐 — 인물 인식 실패`, sample: [] })
if (cues.length && dlgs.length / cues.length < 0.6) issues.push({ level: 'bad', msg: `대사(${dlgs.length})가 화자(${cues.length}) 대비 너무 적다`, sample: [] })

console.log(`[검증] ${path.split('/').pop()}`)
console.log(`  씬 ${scenes.length} · 화자 ${cues.length} · 대사 ${dlgs.length}`)
const bad = issues.filter(i => i.level === 'bad')
const warn = issues.filter(i => i.level === 'warn')
for (const i of issues) {
  console.log(`  ${i.level === 'bad' ? '✗' : '⚠'} ${i.msg}`)
  for (const s of i.sample) console.log(`       ${s}`)
}
if (!issues.length) console.log('  ✓ 이상 없음')

if (bad.length) { console.log(`\n번역에 들어가기엔 원문이 불안정하다(심각 ${bad.length}건).`); process.exit(6) }
if (warn.length && STRICT) process.exit(5)
process.exit(0)
