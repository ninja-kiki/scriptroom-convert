// PDF x좌표 기반 재포맷 — 들여쓰기로 씬/인물/대사/괄호/지문 분리.
// 줄나눔 뭉침(문제1) 작품을 PDF에서 다시 포맷. _formatted.txt만 새로 씀(번역은 realign으로 재정렬).
// 사용: node tools/pdf-reformat.mjs <PDF경로> [--write <출력경로>]   (--write 없으면 stdout 미리보기)
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, writeFileSync } from 'fs'

const pdfPath = process.argv[2]
const wi = process.argv.indexOf('--write')
const outPath = wi >= 0 ? process.argv[wi + 1] : null
if (!pdfPath) { console.error('PDF 경로 필요'); process.exit(1) }

// 1) 줄 추출 (text, x=시작좌표, y) — y로 줄 묶고, 페이지번호/머리말 제거는 단순화
async function extractLines(path) {
  const data = new Uint8Array(readFileSync(path))
  const pdf = await getDocument({ data }).promise
  const lines = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const items = (await page.getTextContent()).items.filter(i => 'str' in i)
    let lastY = null, x = null, text = ''
    const push = () => { if (text.trim()) lines.push({ text: text.replace(/\s+/g, ' ').trim(), x, y: lastY, page: p }) }
    for (const it of items) {
      const ix = it.transform[4], iy = it.transform[5]
      if (lastY !== null && Math.abs(iy - lastY) > 3) { push(); text = ''; x = null }
      if (x === null) x = ix
      text += it.str; lastY = iy
    }
    push()
  }
  return lines
}

// 2) x밴드 자동 감지: 지문(좌측 최빈), 인물(큰 들여쓰기), 대사(중간)
function detectBands(lines) {
  const freq = {}
  for (const l of lines) { const b = Math.round(l.x / 5) * 5; freq[b] = (freq[b] || 0) + 1 }
  const xsByFreq = Object.entries(freq).map(([x, n]) => [+x, n]).sort((a, b) => b[1] - a[1])
  const xAction = Math.min(...xsByFreq.slice(0, 3).map(e => e[0]))   // 상위 빈도 중 가장 왼쪽 = 지문 여백
  return { xAction, dialogue: xAction + 50, character: xAction + 110, transition: xAction + 320 }
}

const SCENE_RE = /^(#?\s*)(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i
const TRANS_RE = /(CUT TO:|FADE (IN|OUT|TO)|DISSOLVE TO:|SMASH CUT|MATCH CUT)\s*$/i
const TIME = /\b(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|LATER|EARLIER|CONTINUOUS|MOMENTS|SAME|SUNSET|SUNRISE)\b/
const isSlug = (s) => { if (!/\s[-–—]\s/.test(s) || s.length > 70) return false; const L = s.replace(/[^A-Za-z]/g, ''), U = s.replace(/[^A-Z]/g, ''); return L.length >= 3 && U.length / L.length >= 0.85 && TIME.test(s.split(/\s[-–—]\s/).pop()) }
function isRealCue(s) {
  let c = s.replace(/\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT|MORE)\.?\)\s*$/i, '').trim()
  if (!c || c.length > 28 || /[.,!?;]$/.test(c) || c.split(/\s+/).length > 4) return false
  if (/^(ON|IN|AT|TO|INSERT|CU|POV|ANGLE|CLOSE|WIDE|BACK|REVERSE|MONTAGE|INTERCUT|SERIES|MUSIC|CHYRON|SUPER|CREDIT|ACROSS|THROUGH)\b/i.test(c)) return false
  const L = c.replace(/[^A-Za-z]/g, ''), U = c.replace(/[^A-Z]/g, '')
  return L.length >= 2 && U.length / L.length >= 0.9
}
function classify(line, b) {
  const s = line.text.trim()
  if (SCENE_RE.test(s) || isSlug(s)) return 'scene'
  if (TRANS_RE.test(s) || line.x >= b.transition) return 'transition'
  if (line.x >= b.character && isRealCue(s)) return 'character'
  if (/^\(.*\)$/.test(s)) return 'paren'
  if (line.x >= b.dialogue && line.x < b.character) return 'dialogue'
  return 'action'
}

function build(lines, b) {
  // 줄 높이(문단 갭 판정용): 같은 페이지 연속 줄 y차의 최빈값
  const gaps = []
  for (let i = 1; i < lines.length; i++) if (lines[i].page === lines[i - 1].page) gaps.push(Math.round(lines[i - 1].y - lines[i].y))
  const lh = (gaps.filter(g => g > 2).sort((a, b) => a - b)[Math.floor(gaps.length / 2)]) || 14

  const out = []
  let cur = null  // { type, text }
  const flush = () => { if (cur) { out.push(cur); cur = null } }
  let prev = null
  for (const line of lines) {
    const type = classify(line, b)
    const s = line.text.trim()
    if (!s) continue
    // 페이지번호/단독숫자/머리말 잡음 스킵
    if (/^\d{1,4}\.?$/.test(s) || /^(CONTINUED|CONT'D)[:.]?$/i.test(s) || s.length < 1) continue
    if (type === 'scene') { flush(); out.push({ type, text: '# ' + s.replace(/^#\s*/, '').replace(/^[A-Z]?\d+\.?\s+/, '').replace(/\s*[A-Z]?\d+\.?$/, '').trim() }) ; prev = line; continue }
    if (type === 'character') { flush(); out.push({ type, text: '@' + s.replace(/[:：]\s*$/, '').trim() }); prev = line; continue }
    if (type === 'paren') { flush(); out.push({ type, text: s }); prev = line; continue }
    if (type === 'transition') { flush(); out.push({ type, text: s }); prev = line; continue }
    // dialogue/action: 연속 줄 병합(soft wrap). 단 문단 갭(>1.6*lh)이나 타입 바뀌면 끊기
    const bigGap = prev && line.page === prev.page && (prev.y - line.y) > lh * 1.7
    if (cur && cur.type === type && !bigGap) cur.text += ' ' + s
    else { flush(); cur = { type, text: s } }
    prev = line
  }
  flush()

  // 첫 씬 헤딩(#) 이전 = 타이틀 페이지/에피그래프 → 버림
  const firstScene = out.findIndex(b => b.type === 'scene')
  const body = firstScene > 0 ? out.slice(firstScene) : out

  // 블록 사이 빈 줄 1개로 렌더 (scriptroom 규칙: 빈 줄=경계)
  return body.map(b => b.text).join('\n\n') + '\n'
}

const lines = await extractLines(pdfPath)
const bands = detectBands(lines)
console.error(`줄 ${lines.length} · x밴드: 지문<${bands.dialogue} 대사${bands.dialogue}-${bands.character} 인물≥${bands.character}`)
const formatted = build(lines, bands)
if (outPath) { writeFileSync(outPath, formatted); console.error(`→ ${outPath} (${formatted.split('\n\n').length} 블록)`) }
else console.log(formatted.split('\n').slice(0, 60).join('\n'))
