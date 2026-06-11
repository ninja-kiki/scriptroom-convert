// 번역본 검수 엔진 — 전부 코드 기반(토큰 0). 브라우저/노드 공용.
// detect(text) → 카테고리별 결함 + 자동수정 가능 여부.  autofix(text) → 청소된 텍스트.

const ko = t => (t.match(/[가-힣]/g) || []).length
const la = t => (t.match(/[A-Za-z]/g) || []).length

// ── 메타 코멘트(LLM이 흘린 "내가 뭘 했다") ─────────────────
const META = [
  /^\s*```/,
  /^\s*[(\[][^)\]]*(제거|생략|removed|omitted|no (screenplay|script) content|번역할.*?없|포맷할.*?없|내용\s*없)[^)\]]*[)\]]\s*$/i,
  /^\s*(번역|포맷)\s*(결과|본|텍스트|된\s*각본)?\s*[:：]\s*$/,
  /^\s*(다음은|아래는|여기(?:에|는)?)\s.*(번역|포맷|각본|결과).*[:：]\s*$/,
  /^\s*(here(?:'s| is)|below is)\b.*(translat|format|script).*[:：]?\s*$/i,
  /^\s*(물론입니다|알겠습니다|네[,，]?\s*알겠|좋습니다)[.!]?\s*$/,
  /^\s*(sure|certainly|of course)\b.*$/i,
  /^\s*(translator'?s?\s*note|역자\s*주|옮긴이\s*주|주\s*[:：]|참고\s*[:：])/i,
  /^\s*(이상입니다|번역을?\s*(완료|마쳤|마칩니다)|도움이\s*되(?:셨|었))/,
  /(포함되지\s*않았|붙여넣어?\s*주시|올려\s*주시|보내\s*주시|번역해\s*드리겠|번역을?\s*시작하겠|제공해\s*주세요|원문\s*텍스트를)/,
]
const isMeta = l => META.some(re => re.test(l))

const isMarker = t => /^[#@]/.test(t) || /^\[(크레딧|자막|CREDIT|SUPER)/i.test(t) ||
  /^(CUT TO|FADE|DISSOLVE|SMASH CUT|MATCH CUT|암전|검은 ?화면)/i.test(t)

const sig = t => t.trim().toLowerCase().replace(/\d+/g, ' ')
  .replace(/[[\]().,/'"“”\-–—:!?]/g, ' ').replace(/\s+/g, ' ').trim()

const isHeaderShape = t =>
  /\b(draft|rev\.?|revision|shooting\s+(script|draft)|yellow|blue|pink|green|salmon|white|goldenrod)\b/i.test(t) ||
  /\(?\d{1,2}\/\d{1,2}\/\d{2,4}\)?/.test(t) || /\[\d{2,4}\]\s*\d/.test(t) ||
  /\b(mm\/dd\/yy)\b/i.test(t) || /["”]\s*\d{1,3}[A-Z]?\.\s*$/.test(t)
const isStandaloneBoiler = t => /^\(?(CONTINUED|MORE)\)?:?$/i.test(t.replace(/\s+/g, ' ').trim())
// 반복 안 해도 확실한 러닝헤더 (개정번호+날짜, 타이틀+페이지) — LLM이 제각각 번역해도 잡힘
const isStrongHeader = t =>
  /\[\d{2,4}\]\s*\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t) ||
  /\b(rev\.?|revised|draft|초고|수정본|드래프트|개정)\b.*\[\d{2,4}\]/i.test(t) ||
  /["”]\s*\d{1,3}(-\d{1,3})?[A-Z]?\.\s*$/.test(t)
const isUntranslated = t => la(t) >= 10 && ko(t) === 0
// 구조/지시문(샷슬러그·화자큐·타이틀): 전부 대문자/괄호만/따옴표만/POV·OS·VO
const isStructural = t => !/[a-z]/.test(t) || /^\(.+\)$/.test(t) || /^["'].*["']$/.test(t) || /\b(POV|O\.S\.|V\.O\.)\b/.test(t)

// ── 검출 ────────────────────────────────────────────────
export function detect(text) {
  const lines = text.split('\n')
  const out = { meta: [], boiler: [], dupe: [], headNum: [], bilingual: [], dialog: [], struct: [], spacing: 0 }

  // 반복 러닝헤더 시그니처
  const freq = new Map()
  for (const l of lines) { const t = l.trim(); if (t && !isMarker(t) && isHeaderShape(t)) { const s = sig(t); if (s.length >= 2) freq.set(s, (freq.get(s) || 0) + 1) } }
  const boilerSig = new Set([...freq].filter(([, c]) => c >= 4).map(([s]) => s))

  let prev = null
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!t) { prev = ''; return }
    if (isMeta(t)) out.meta.push(i)
    else if (isStandaloneBoiler(t) || isStrongHeader(t) || (isHeaderShape(t) && boilerSig.has(sig(t)))) out.boiler.push(i)
    if (t === prev) out.dupe.push(i)
    if (/^#/.test(t) && /[가-힣\s)\]]\d{1,3}$/.test(t) && !/(19|20)\d{2}$/.test(t)) out.headNum.push(i)
    if (!isMarker(t) && isUntranslated(t)) (isStructural(t) ? out.struct : out.dialog).push(i)
    if (/^[#@]/.test(t) && prev !== '' && prev !== null) out.spacing++
    prev = t
  })

  out.bilingual = findBilingual(lines)
  out.lines = lines.length
  return out
}

// ── EN+KO 중복 블록 ─────────────────────────────────────
const isTransitionish = t => /^#/.test(t) || isHeaderShape(t) ||
  /^(CUT|FADE|DISSOLVE|SMASH|MATCH|JUMP|SLAM|TIME|SUDDEN|QUICK|HARD|BACK TO|INTERCUT|CONTINUED|OMITTED|SCENES?\b|WE CUT|END\b|TITLE|CREDIT|MONTAGE|INSERT|TWO SHOT|CLOSEUP|CU\b|POV)/i.test(t)
const looksForeign = t => /[äöüßÄÖÜçéèêëàâùûîïñ]/.test(t) ||
  /\b(bitte|nicht|ich|kamerad|wasser|mein|gott|wo ist|vous|nous|ne pas|une fille|asseyez|gracias|señor|por favor|comprende|vámonos|merci|bonne|donde|casa)\b/i.test(t)
const looksTitle = t => /^['"]/.test(t.trim()) || /['"]\s+by\s+/i.test(t)

function blocks(lines) {
  const bs = []; let cur = null
  lines.forEach((l, i) => {
    if (l.trim() === '') { if (cur) { bs.push(cur); cur = null } }
    else { if (!cur) cur = { lines: [], start: i, end: i }; cur.lines.push(l); cur.end = i }
  })
  if (cur) bs.push(cur)
  return bs
}
function findBilingual(lines) {
  const bs = blocks(lines)
  const drops = []
  const cueOf = b => (b[0] && /^@/.test(b[0].trim())) ? b[0].trim() : null
  const body = b => b.filter(l => !/^@/.test(l.trim())).join(' ')
  const isEN = b => { const t = body(b); return ko(t) === 0 && la(t) >= 8 }
  const isKO = b => ko(body(b)) >= 2
  const isProse = b => { const t = body(b).trim(); return /[a-z]/.test(t) && t.split(/\s+/).length >= 3 }
  for (let i = 0; i < bs.length - 1; i++) {
    const a = bs[i], b = bs[i + 1]
    if (!isEN(a.lines) || !isKO(b.lines)) continue
    if (a.lines.some(l => isTransitionish(l.trim()))) continue
    if (looksForeign(body(a.lines)) || looksTitle(body(a.lines)) || /^\s*\[/.test(a.lines[0])) continue
    const r = ko(body(b.lines)) / Math.max(1, la(body(a.lines)))
    if (r < 0.4 || r > 3) continue
    const ca = cueOf(a.lines), cb = cueOf(b.lines)
    const sameCue = ca && cb && ca.replace(/\s+/g, '') === cb.replace(/\s+/g, '')
    if (sameCue || (!ca && !cb && isProse(a.lines))) drops.push({ start: a.start, end: a.end })
  }
  return drops
}

// ── 자동수정 (안전한 결함만) ────────────────────────────
export function autofix(text) {
  let lines = text.split('\n')
  const is = detect(text)
  const drop = new Set([...is.meta, ...is.boiler, ...is.dupe])
  is.bilingual.forEach(d => { for (let i = d.start; i <= d.end; i++) drop.add(i) })
  lines = lines.filter((_, i) => !drop.has(i))
  // 헤딩끝 페이지번호 + 줄나눔 정리
  const res = []
  for (let l of lines) {
    let t = l.trim()
    if (/^#/.test(t) && /[가-힣\s)\]]\d{1,3}$/.test(t) && !/(19|20)\d{2}$/.test(t)) { l = l.replace(/(\d{1,3})\s*$/, '').replace(/\s+$/, ''); t = l.trim() }
    if (t === '') { if (res.length && res[res.length - 1] === '') continue; res.push(''); continue }
    if (/^[#@]/.test(t) && res.length && res[res.length - 1] !== '') res.push('')
    res.push(l.replace(/\s+$/, ''))
  }
  while (res.length && res[0] === '') res.shift()
  while (res.length && res[res.length - 1] === '') res.pop()
  return res.join('\n')
}

// 요약(배지용)
export function summarize(text) {
  const is = detect(text)
  return {
    meta: is.meta.length, boiler: is.boiler.length, dupe: is.dupe.length,
    headNum: is.headNum.length, bilingual: is.bilingual.length,
    dialog: is.dialog.length, struct: is.struct.length,
    spacing: is.spacing > is.lines * 0.15 ? is.spacing : 0,
    autofixable: is.meta.length + is.boiler.length + is.dupe.length + is.bilingual.length + is.headNum.length,
    review: is.dialog.length,
  }
}
