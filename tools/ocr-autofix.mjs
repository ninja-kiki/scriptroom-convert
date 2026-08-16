// ocr-triage 가 '확신한다'고 판단한 것만 실제로 고친다.
//   확신 기준: 문서 안에 훨씬 자주 나오는 비슷한 형태가 있고(빈도 3배 이상),
//              바뀌는 글자가 OCR이 실제로 헷갈리는 조합일 때만.
//   부기 나이츠는 정답지가 있어 이 교정이 '맞았는지'까지 채점할 수 있다.
//
//   사용: node tools/ocr-autofix.mjs <formatted.txt> [--write <출력>]
import { readFileSync, writeFileSync } from 'fs'

const path = process.argv[2]
const wi = process.argv.indexOf('--write')
if (!path) { console.error('사용: node tools/ocr-autofix.mjs <입력> [--write <출력>]'); process.exit(1) }
let text = readFileSync(path, 'utf8')

const freq = new Map()
for (const m of text.matchAll(/[A-Za-z][A-Za-z'’]*/g)) freq.set(m[0], (freq.get(m[0]) || 0) + 1)

const looksOcr = w => {
  const s = w.replace(/[^A-Za-z]/g, '')
  if (s.length < 3) return false
  if (!/[aeiouyAEIOUY]/.test(s)) return true
  if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(s)) return true
  if (/[A-Z][a-z]*[A-Z][a-z]/.test(w) && w.length > 4) return true
  return false
}
// OCR이 실제로 헷갈리는 글자쌍만 인정 — 아무 한 글자 차이나 다 고치면 원문을 망가뜨린다
const CONFUSE = new Set(['I|l','l|I','I|1','1|I','l|1','1|l','O|0','0|O','O|D','D|O','o|c','c|o',
  'e|c','c|e','s|o','o|s','n|h','h|n','H|B','B|H','u|v','v|u','t|f','f|t','g|q','q|g','i|j','j|i',
  'm|n','n|m','w|v','v|w','a|o','o|a','S|5','5|S','B|8','8|B','G|6','6|G','Z|2','2|Z'])
const oneCharSwap = (a, b) => {
  if (a.length !== b.length) return null
  let d = null
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (d) return null
    d = `${a[i]}|${b[i]}`
  }
  return d
}

const vocab = [...freq.entries()].filter(([w, n]) => n >= 3 && !looksOcr(w)).map(([w]) => w)
const fixes = []
for (const [w, n] of freq) {
  if (!looksOcr(w)) continue
  let best = null, bestN = 0
  for (const v of vocab) {
    if (v.length !== w.length) continue
    const sw = oneCharSwap(w, v)
    if (!sw || !CONFUSE.has(sw)) continue
    const vn = freq.get(v) || 0
    if (vn > n * 3 && vn > bestN) { best = v; bestN = vn }
  }
  if (best) fixes.push({ from: w, to: best, count: n })
}

let applied = 0
for (const f of fixes) {
  const re = new RegExp(`\\b${f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  const before = text
  text = text.replace(re, f.to)
  if (text !== before) applied += f.count
}
console.log(`자동교정 ${fixes.length}종 · ${applied}곳`)
for (const f of fixes.slice(0, 12)) console.log(`    ${f.from} → ${f.to} (${f.count})`)
if (wi >= 0) { writeFileSync(process.argv[wi + 1], text); console.log(`→ ${process.argv[wi + 1]}`) }
