// 기존 변환 작품 전수 검토 + 분류 (A: PDF 재투입 / B: 텍스트 후처리 가능 / C: 좌표 추출 불가 의심)
// scriptroom 블록 규칙으로 파싱해 줄나눔 뭉침·@ 과탐지를 측정.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
const DIR = '/Users/hojun/Projects/scriptroom/content'

// ── 블록 파싱 (scriptroom 규칙) + 가짜 큐 판별 ──
const isScene = (l) => /^#\s*(INT|EXT|내부|외부)/i.test(l.trim())
const isParen = (l) => { const t = l.trim(); return t.startsWith('(') && t.endsWith(')') }
function looksLikeRealCue(line) {
  let s = line.trim().replace(/^@\s*/, '').trim()
  s = s.replace(/\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT|MORE|소리|필터|화면\s*밖)\.?\)\s*$/i, '').trim()
  if (!s || s.length > 28) return false
  if (/[.,!?;…·]$/.test(s)) return false
  if (s.split(/\s+/).length > 4) return false
  if (/^(ON|IN|AT|TO|FROM|OVER|INSERT|CU|POV|ANGLE|CLOSE|WIDE|BACK|REVERSE|MONTAGE|INTERCUT|SERIES|MEANWHILE|VARIOUS|LATER|CONTINUOUS|MUSIC|CHYRON|SUPER|CREDIT|OMITTED|ACROSS|THROUGH|OTHER SIDE)\b/i.test(s)) return false
  if (/\b(STAGE|TV|ROOM|COUNTER|CURTAIN|TURNBUCKLE|HALLWAY|LOBBY)\b/i.test(s) && !/^(MISTER|MISS|MRS|DOCTOR|DR|OFFICER|DETECTIVE)/i.test(s)) return false
  if (/[가-힣]/.test(s) && /(다|요|까|네|군|지|어|아|니|데|음|함)\.?$/.test(s)) return false
  return true
}
function parseBlocks(text) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks = []; let cur = null; let dlg = false
  const flush = () => { if (cur && cur.lines.length) blocks.push({ type: cur.type, text: cur.lines.join(' ') }); cur = null }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') { flush(); continue }
    if (isScene(line)) { flush(); blocks.push({ type: 'scene', text: line.trim() }); dlg = false; continue }
    if (/^@/.test(line.trim())) {
      if (looksLikeRealCue(line)) { flush(); blocks.push({ type: 'character', text: line.trim() }); dlg = true; continue }
      // 가짜 큐는 지문으로 (분류 측정용)
      const d = line.trim().replace(/^@\s*/, ''); flush(); cur = { type: 'action', lines: [d] }; dlg = false; continue
    }
    if (dlg && isParen(line) && !cur) { flush(); blocks.push({ type: 'paren', text: line.trim() }); continue }
    const kind = dlg ? 'dialogue' : 'action'
    if (!cur || cur.type !== kind) { flush(); cur = { type: kind, lines: [] } }
    cur.lines.push(line)
  }
  flush()
  return blocks
}
const words = (s) => (s.trim().match(/\S+/g) || []).length
const sentences = (s) => (s.match(/[.!?。]/g) || []).length

const rows = []
for (const w of readdirSync(DIR)) {
  const dir = join(DIR, w)
  try { if (!statSync(dir).isDirectory()) continue } catch { continue }
  const ff = readdirSync(dir).find(f => /_formatted\.txt$/.test(f))
  if (!ff) continue
  const text = readFileSync(join(dir, ff), 'utf8')
  const blocks = parseBlocks(text)
  const actions = blocks.filter(b => b.type === 'action')
  const dialogues = blocks.filter(b => b.type === 'dialogue')
  // @ 과탐지: 원본에서 @로 시작했지만 가짜인 라벨 수
  let falseCue = 0
  for (const l of text.split('\n')) { const t = l.trim(); if (t.startsWith('@') && !looksLikeRealCue(t)) falseCue++ }
  // 줄나눔 뭉침 지표
  const avgActWords = actions.length ? Math.round(actions.reduce((a, b) => a + words(b.text), 0) / actions.length) : 0
  const longAct = actions.filter(b => words(b.text) > 60).length
  const longActPct = actions.length ? Math.round(longAct / actions.length * 100) : 0
  const longDlg = dialogues.filter(b => words(b.text) > 50).length      // 대사+지문 병합 의심
  const longDlgPct = dialogues.length ? Math.round(longDlg / dialogues.length * 100) : 0
  // OCR 깨짐 의심 (이상문자 비율)
  const garbage = (text.match(/[^\x09\x0A\x0D\x20-\x7E가-힣 -ɏ‐-‧‰-⁞]/g) || []).length
  const garbagePct = Math.round(garbage / text.length * 1000) / 10
  rows.push({ w, blocks: blocks.length, act: actions.length, avgActWords, longActPct, dlg: dialogues.length, longDlgPct, falseCue, garbagePct })
}

// 분류: A=줄나눔 뭉침(긴 지문/대사+지문 병합 많음), C=OCR깨짐 의심, B=나머지(텍스트 후처리 가능)
function classify(r) {
  if (r.garbagePct > 1.5) return 'C'                                   // OCR 깨짐 의심
  if (r.avgActWords > 45 || r.longActPct > 30 || r.longDlgPct > 25) return 'A'  // 줄나눔 뭉침
  return 'B'
}
rows.forEach(r => r.cls = classify(r))
rows.sort((a, b) => a.cls.localeCompare(b.cls) || b.avgActWords - a.avgActWords)
console.log('cls | 작품 | 지문평균단어 긴지문% 긴대사% | 가짜@ | OCR% | 근거')
for (const r of rows) {
  const basis = r.cls === 'A' ? `지문뭉침(평균 ${r.avgActWords}단어/긴지문 ${r.longActPct}%/병합대사 ${r.longDlgPct}%)`
    : r.cls === 'C' ? `OCR 깨짐 의심 ${r.garbagePct}%`
    : `줄나눔 정상 · @오탐 ${r.falseCue}개`
  console.log(`${r.cls} | ${r.w} | ${r.avgActWords} ${r.longActPct}% ${r.longDlgPct}% | @${r.falseCue} | ${r.garbagePct}% | ${basis}`)
}
const c = (x) => rows.filter(r => r.cls === x).length
console.log(`\n분류: A(PDF재투입) ${c('A')} · B(후처리가능) ${c('B')} · C(좌표불가의심) ${c('C')}`)
