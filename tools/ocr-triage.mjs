// OCR 오인식을 '기계가 고칠 것'과 '사람에게 물어볼 것'으로 나눈다.
//   목적: 규칙을 잘게 늘리는 대신, 기계가 확신할 수 있는 것만 자동으로 고치고
//        나머지는 사람에게 '한 번만' 물어 전체에 반영한다(같은 오인식이 12번 나와도 질문은 1개).
//
//   사용: node tools/ocr-triage.mjs <formatted.txt> [--json <출력>]
import { readFileSync, writeFileSync } from 'fs'

const path = process.argv[2]
const ji = process.argv.indexOf('--json')
if (!path) { console.error('사용: node tools/ocr-triage.mjs <formatted.txt> [--json <out>]'); process.exit(1) }
const text = readFileSync(path, 'utf8')
const lines = text.split('\n')

// ── 1) 어휘 빈도 (정상으로 보이는 단어만 후보군에 넣는다)
const tokenRe = /[A-Za-z][A-Za-z'’]*/g
const freq = new Map()
for (const m of text.matchAll(tokenRe)) {
  const w = m[0]
  freq.set(w, (freq.get(w) || 0) + 1)
}

// ── 2) OCR 흔적이 있는 토큰 골라내기 (형태만 보고 판단 — 언어 추측 아님)
const looksOcr = w => {
  const s = w.replace(/[^A-Za-z]/g, '')
  if (s.length < 3) return false
  // ★y를 모음으로 세지 않으면 cry·why·gym·try·gypsy 같은 멀쩡한 낱말을 오인식으로 잡고,
  //   심지어 sky→say, spy→say 로 '고쳐서' 원문을 망가뜨린다. y는 모음으로 센다.
  if (!/[aeiouyAEIOUY]/.test(s)) return true                     // 모음 없음
  if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(s)) return true         // 자음 5연속
  if (/[A-Z][a-z]*[A-Z]{1}[a-z]/.test(w) && w.length > 4) return true  // 대소문자 뒤엉킴(giI'l)
  return false
}
const editDist = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 9
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1].toLowerCase() === b[j-1].toLowerCase() ? 0 : 1))
  return dp[a.length][b.length]
}

const vocab = [...freq.entries()].filter(([w, n]) => n >= 3 && !looksOcr(w)).map(([w]) => w)
const auto = [], ask = []
for (const [w, n] of freq) {
  if (!looksOcr(w)) continue
  // 문서 안에 훨씬 자주 나오는 비슷한 형태가 있으면 그쪽이 정답 — 기계가 고칠 수 있다
  let best = null, bestN = 0
  for (const v of vocab) {
    if (Math.abs(v.length - w.length) > 2) continue
    if (editDist(w, v) <= 1 && (freq.get(v) || 0) > n * 3 && (freq.get(v) || 0) > bestN) { best = v; bestN = freq.get(v) }
  }
  if (best) auto.push({ from: w, to: best, count: n, ref: bestN })
  else ask.push({ token: w, count: n })
}

// ── 3) 숫자 훼손 — 기계가 원래 값을 알 방법이 없다
const badNum = new Map()
for (const m of text.matchAll(/\b\d+[^\s\w]{1,2}(?=\s|$)|\b\d*[{}\[\]|]\d*\b/g)) {
  const t = m[0].trim()
  if (/^\d+[.,;:!?]$/.test(t)) continue      // 정상 문장부호
  badNum.set(t, (badNum.get(t) || 0) + 1)
}

// ── 4) 화자 큐는 따로 — 갈리면 리더기에서 다른 인물로 보인다
const cues = new Map()
for (const l of lines) if (l.startsWith('@')) {
  const n = l.slice(1).split('(')[0].trim()
  if (n) cues.set(n, (cues.get(n) || 0) + 1)
}
const cueFix = []
for (const [a, na] of cues) {
  if (na > 3) continue
  for (const [b, nb] of cues) {
    if (a === b || nb < na * 3) continue
    if (a.length === b.length && editDist(a, b) === 1) { cueFix.push({ from: a, to: b, count: na, ref: nb }); break }
  }
}

const askTotal = ask.reduce((s, x) => s + x.count, 0)
const autoTotal = auto.reduce((s, x) => s + x.count, 0)
console.log(`[${path.split('/').pop()}]`)
console.log(`  기계가 고칠 수 있음   고유형태 ${String(auto.length).padStart(4)}종 · 실제 ${String(autoTotal).padStart(5)}곳`)
console.log(`  화자 큐 자동 교정     ${String(cueFix.length).padStart(4)}종`)
console.log(`  ── 사람에게 물어볼 것 ──`)
console.log(`  정체불명 단어         ${String(ask.length).padStart(4)}종 · 실제 ${String(askTotal).padStart(5)}곳`)
console.log(`  훼손된 숫자           ${String(badNum.size).padStart(4)}종`)
console.log(`  ▶ 사람이 답할 질문 총 ${ask.length + badNum.size}개`)
if (auto.length) console.log(`\n  자동교정 예: ` + auto.slice(0, 5).map(a => `${a.from}→${a.to}(${a.count})`).join(', '))
if (ask.length) console.log(`  질문 예:     ` + ask.slice(0, 8).map(a => `${a.token}(${a.count})`).join(', '))
if (badNum.size) console.log(`  숫자 예:     ` + [...badNum.keys()].slice(0, 6).join(', '))

if (ji >= 0) writeFileSync(process.argv[ji + 1], JSON.stringify({ auto, cueFix, ask, badNum: [...badNum] }, null, 2))
