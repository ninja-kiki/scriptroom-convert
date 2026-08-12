// 텍스트로 된 각본(.txt/.rtf에서 변환)을 구조 마커가 붙은 formatted 형식으로 만든다.
//   pdf-reformat.mjs 는 PDF의 x좌표를 쓰지만, 텍스트 각본에는 좌표가 없다.
//   대신 '선행 공백 수'가 같은 역할을 한다 — 지문 0칸 / 대사 중간 / 인물 깊숙이.
//
//   사용: node tools/text-reformat.mjs <입력.txt> --write <출력.txt>
//
// 밴드는 고정값이 아니라 파일에서 추정한다(각본마다 여백이 다르다).
// 들여쓰기만으로는 부족하다 — 대사가 중앙 정렬로 밀려 인물 밴드에 들어오는 일이 있어
// pdf-reformat 과 같은 형태 규칙(isRealCue)을 함께 건다.
import { readFileSync, writeFileSync } from 'fs'

const SCENE_RE = /^(#?\s*)([A-Z]{0,2}\d{1,3}[A-Z]?\.?\s+)?(INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|(?:INT|EXT)(?:\.|\s|—|–)|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i
const TRANS_RE = /^(?:(?:SMASH|MATCH|JUMP|HARD|QUICK)(?:\s+CUT)?\s+)?(?:CUT|DISSOLVE|FADE|WIPE|TRANSITION|FLASH(?:\s+BACK)?)?(?:\s*(?:TO|IN|OUT|UP|BACK))*(?:\s+BLACK|\s+WHITE)?\s*:?\s*$/i
const TIME = /\b(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|LATER|EARLIER|CONTINUOUS|MOMENTS|SAME|SUNSET|SUNRISE)\b/

function isRealCue(s) {
  let c = s.replace(/\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT|MORE)\.?\)\s*$/i, '').trim()
  if (!c || c.length > 28 || /[.,!?;]$/.test(c) || c.split(/\s+/).length > 4) return false
  if (/^(ON|IN|AT|TO|INSERT|CU|POV|ANGLE|CLOSE|WIDE|BACK|REVERSE|MONTAGE|INTERCUT|SERIES|MUSIC|CHYRON|SUPER|CREDIT|ACROSS|THROUGH|FULL|MED|MEDIUM|TWO|THREE|GROUP|TIGHT|LOW|HIGH|AERIAL|TRACKING|PAN|ZOOM|RESUME|FAVORING)\b/i.test(c)) return false
  // TV 각본의 막 구분(ACT ONE·END TEASER·COLD OPEN)은 구조 표시지 화자가 아니다.
  //   화자로 잡히면 '@ACT ONE' 같은 가짜 인물이 생기고 리더기 화자 목록까지 오염된다.
  if (/^(ACT|END OF ACT|END ACT|TEASER|END TEASER|COLD OPEN|END OF TEASER|TAG|END OF SHOW|MAIN TITLES?|END CREDITS)\b/i.test(c)) return false
  const L = c.replace(/[^A-Za-z]/g, ''), U = c.replace(/[^A-Z]/g, '')
  return L.length >= 2 && U.length / L.length >= 0.9
}
const isSlug = s => {
  if (!/\s[-–—]\s/.test(s) || s.length > 70) return false
  const L = s.replace(/[^A-Za-z]/g, ''), U = s.replace(/[^A-Z]/g, '')
  return L.length >= 3 && U.length / L.length >= 0.85 && TIME.test(s.split(/\s[-–—]\s/).pop())
}

const [inPath, , outPath] = [process.argv[2], process.argv[3], process.argv[4]]
if (!inPath || !outPath) { console.error('사용: node tools/text-reformat.mjs <입력> --write <출력>'); process.exit(1) }

const raw = readFileSync(inPath, 'utf8').split('\n')
const indentOf = l => l.length - l.trimStart().length

// 인물 밴드 추정: 화자 형태(isRealCue)를 만족하는 줄들이 몰려 있는 들여쓰기를 찾는다
const cueIndents = raw.filter(l => l.trim() && isRealCue(l.trim())).map(indentOf).sort((a, b) => a - b)
const CUE_BAND = cueIndents.length >= 20 ? cueIndents[Math.floor(cueIndents.length * 0.25)] : 30
// 대사 밴드: 지문(0칸 근처)과 인물 사이
const DLG_BAND = Math.max(4, Math.round(CUE_BAND * 0.45))
console.log(`들여쓰기 밴드: 지문<${DLG_BAND} · 대사${DLG_BAND}-${CUE_BAND - 1} · 인물≥${CUE_BAND - 2}`)

const out = []
let cur = null          // { type, text }
let afterCue = false
const flush = () => { if (cur) { out.push(cur.type === 'dialogue' ? { ...cur, text: '- ' + cur.text } : cur); cur = null } }

for (const line of raw) {
  const s = line.trim()
  if (!s) { flush(); afterCue = afterCue && true; continue }
  const ind = indentOf(line)

  // 페이지번호·씬번호 단독 줄, CONTINUED 류는 버린다
  if (/^\*?\s*[A-Z]{0,2}\d{1,4}[A-Z]?\.?\*?$/.test(s)) continue
  if (/^\(?(CONTINUED|CONT'D|MORE)\)?\s*:?\s*(\(\d+\))?\s*\d{0,4}[A-Za-z]?\.?$/i.test(s)) continue

  // 씬 헤딩 — 앞의 씬번호(1, 24A)를 떼고 마커를 붙인다
  if (SCENE_RE.test(s) || isSlug(s)) {
    flush(); afterCue = false
    out.push({ type: 'scene', text: '# ' + s.replace(/^#\s*/, '').replace(/^[A-Z]{0,2}\d+[A-Z]?\.?\s+/, '').replace(/\s*[A-Z]{0,2}\d+[A-Z]?\.?\*?$/, '').trim() })
    continue
  }
  if (TRANS_RE.test(s)) { flush(); afterCue = false; out.push({ type: 'transition', text: '(' + s.replace(/^\(+|\)+$/g, '').trim() + ')' }); continue }
  if (/^\(.*\)$/.test(s)) { flush(); out.push({ type: 'paren', text: s }); continue }
  if (ind >= CUE_BAND - 2 && isRealCue(s)) { flush(); afterCue = true; out.push({ type: 'character', text: '@' + s.replace(/[:：]\s*$/, '').trim() }); continue }

  // 큐 직후 첫 본문은 각본 구조상 무조건 대사 — 중앙 정렬로 밴드가 어긋나도 살린다
  let type = ind >= DLG_BAND ? 'dialogue' : 'action'
  if (afterCue) type = 'dialogue'

  if (cur && cur.type === type) cur.text += ' ' + s
  else { flush(); cur = { type, text: s } }
  if (type === 'dialogue') afterCue = false
}
flush()

// 첫 씬 헤딩 이전 = 타이틀 페이지. 제목·by라인·판권은 버리고 실질 내용(오프닝 지문·에피그래프)만 남긴다.
//   pdf-reformat 과 같은 기준. 안 걸러내면 제목이 '@BOOGIE NIGHTS' 라는 화자가 된다.
const META_RE = /written by|screenplay by|story by|teleplay by|based on|draft|shooting script|revision|confidential|propriet|property of|no portion|all rights|reproduced|distribut|prior written|©|copyright|WGA|registered|sole property|\bsuite\b|\bblvd\b|CA\s*\d{5}|^by$/i
const CARD_RE = /^(TITLE:|SUPER:|IN\s*BLACK|OVER\s*BLACK|FADE\s*IN|BLACK\.|CHYRON|INTERTITLE)/i
const keepPre = b => {
  const t = (b.text || '').replace(/^[-@#]\s*/, '').trim()
  if (!t) return false
  if (b.type === 'transition') return true
  if (b.type !== 'action') return false
  if (CARD_RE.test(t)) return true
  if (META_RE.test(t)) return false
  return t.length >= 45
}
const firstScene = out.findIndex(b => b.type === 'scene')
const body = firstScene > 0 ? [...out.slice(0, firstScene).filter(keepPre), ...out.slice(firstScene)] : out
out.length = 0
out.push(...body)

const text = out.map(b => b.text).join('\n\n') + '\n'
writeFileSync(outPath, text)
const n = t => (text.match(t) || []).length
console.log(`→ ${outPath} · 씬 ${n(/^# /gm)} · 인물 ${n(/^@/gm)} · 대사 ${n(/^- /gm)} · 블록 ${out.length}`)
