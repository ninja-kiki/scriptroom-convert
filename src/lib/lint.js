// 번역본 검수 엔진 — 전부 코드 기반(토큰 0). 브라우저/노드 공용.
// detect(text) → 카테고리별 결함 + 자동수정 가능 여부.  autofix(text) → 청소된 텍스트.
import { reflowBody } from './format-rules.js'   // PDF 단 너비로 끊긴 문장 한 줄로 합치기(변환과 동일)

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

// @ 큐인데 실제 화자가 아닐 가능성 (시간/전환 슬러그가 @로 잘못 태깅, 또는 이름+내용 붙음)
const suspiciousCue = t =>
  /^@/.test(t) && (
    /[-–—]\s*$/.test(t) ||                                                                  // 끝이 -- (슬러그/액션 잘림)
    /^@\s*(어느덧|이른|늦은|잠시\s*후|연속|그날|다음\s*날|이튿날|[월화수목금토일]요일|새벽|정오|자정|UNDER|BACK TO|INTERCUT|FADE|MONTAGE|INSERT|SERIES|SUPER|TITLE)\b/i.test(t) ||
    t.replace(/^@/, '').trim().split(/\s+/).length >= 4                                       // @ 뒤 4단어+ = 이름 아니라 문장
  )

// @큐 대사 블록에 섞여 들어간 지문(액션) 감지.
// 신호: 3인칭 named 주어(라틴 고유명사 또는 한글 이름) + 주격/소유격 조사 + 현재형 서술 종결(…다).
// 대사가 이런 형태인 경우는 드물어 비교적 안전. (확정 아님 → '?' 힌트로만)
const namedSubject = t => /(?:^|[\s(])(?:[A-Z][A-Za-z][A-Za-z-]+|[가-힣]{2,})(?:이|가|은|는|의)(?:\s|$)/.test(t)
// 평서형 서술 종결(…다 / …다.)이 줄 끝/중간에. 단 과거형(지문은 보통 현재형)은 제외.
const narration = t => /[가-힣]다(?:[.……)'"]|$)/.test(t) && !/(았|었|였|왔|갔|했|냈|뒀|렸)다(?:[.……)'"]?)$/.test(t.trim())
// 존댓말·구어체·인용·1·2인칭 = 대사 → 지문 아님 (오탐 차단)
const speechy = t => /(니다|니까|세요|십시|까요|나요|어요|아요|에요|예요|죠|잖|거야|거든|는데|군요|네요|라고|냐고|달라|구나|는걸|ㄹ게|을게|드려)/.test(t)
  || /["”'’]\s*$/.test(t)
  || /(?:^|[\s,])(내가|네가|난|넌|우린|우리(?:가|는)|저는|제가|니가|나는|너는)(?:\s|$)/.test(t)
const looksAction = t => {
  const s = t.trim()
  if (/^\(.*\)$/.test(s)) return false          // 괄호 지시문(인라인) — 분리 대상 아님
  if (/이다[.……)'"]?$/.test(s)) return false   // 'X이다' copula = 대사 가능성
  return namedSubject(s) && narration(s) && !speechy(s)
}

// ── 검출 ────────────────────────────────────────────────
export function detect(text) {
  const lines = text.split('\n')
  const out = { meta: [], boiler: [], dupe: [], headNum: [], bilingual: [], dialog: [], struct: [], miscue: [], glued: [], repeat: [], spacing: 0 }

  // 대사 블록(@큐로 시작) 안에서, 2번째 줄 이후에 나타나는 액션 묘사 = 지문 섞임 의심
  for (const b of blocks(lines)) {
    if (!/^@/.test(b.lines[0].trim())) continue
    for (let k = 1; k < b.lines.length; k++) {
      const t = b.lines[k].trim()
      if (!/^[#@]/.test(t) && looksAction(t)) out.glued.push(b.start + k)
    }
  }

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
    if (suspiciousCue(t)) out.miscue.push(i)
    if (/^[#@]/.test(t) && prev !== '' && prev !== null) out.spacing++
    prev = t
  })

  out.bilingual = findBilingual(lines)

  // 통째로 반복된 단락 (번역 고장: 같은 블록이 연달아 3회 이상 = 명백한 고장/루프) — 첫 1개만 남기고 제거.
  // 2회 반복은 노래 후렴 등 의도된 경우가 있어 건드리지 않음(보수적). 실한 블록만(여러 줄 또는 20자+).
  {
    const bs = blocks(lines)
    let i = 0
    while (i < bs.length) {
      const key = bs[i].lines.map(s => s.trim()).join('\n')
      const substantial = bs[i].lines.length >= 2 || key.replace(/\s/g, '').length >= 20
      let j = i + 1
      if (substantial) while (j < bs.length && bs[j].lines.map(s => s.trim()).join('\n') === key) j++
      if (j - i >= 3) for (let k = i + 1; k < j; k++) for (let li = bs[k].start; li <= bs[k].end; li++) out.repeat.push(li)
      i = j > i ? j : i + 1
    }
  }

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

// 한 줄 안 동일 문자열 반복 접기 — 볼드를 텍스트 레이어에 다중으로 그린 PDF(스파이더맨 류)에서
// "외부. 파커 가 - 낮외부. 파커 가 - 낮...1111" 로 뽑힌 헤딩 복구. 접힌 경우에만 꼬리 동일숫자도 접음(연도 보호).
export function collapseRepeatedRun(orig) {
  let s = orig, prev
  do { prev = s; s = s.replace(/(.{6,}?)\1+/g, '$1') } while (s !== prev)
  return s !== orig ? s.replace(/(\d)\1{2,}\s*$/, '$1') : s
}

// 문서 머리(첫 # 헤딩 이전)의 타이틀페이지/판권 잡동사니 판정 — 판권 신호가 있을 때만 제거 대상
const HEAD_JUNK_SIG = /©|COPYRIGHT|판권|ALL RIGHTS|CORPORATION|제출용|촬영 대본|SHOOTING DRAFT|각색 부문|Screenplay by|Written by|원작 소설|Based on|주소|Blvd\.|CA \d{5}/i

// ── 자동수정 (안전한 결함만) ────────────────────────────
export function autofix(text) {
  let lines = text.split('\n')
  const koDoc = /[가-힣]/.test(text)   // 한국어 문서면 [자막:], 영어 포맷이면 [SUPER:]
  const is = detect(text)
  const drop = new Set([...is.meta, ...is.boiler, ...is.dupe, ...is.repeat])
  is.bilingual.forEach(d => { for (let i = d.start; i <= d.end; i++) drop.add(i) })
  // 머리 판권/타이틀페이지 제거 — 첫 # 헤딩 이전 블록에 판권 신호가 있으면, 그 구간의 비마커 줄 제거
  const firstHead = lines.findIndex(l => /^#\s/.test(l.trim()))
  if (firstHead > 0) {
    const head = lines.slice(0, firstHead)
    if (head.some(l => HEAD_JUNK_SIG.test(l))) {
      head.forEach((l, i) => {
        const t = l.trim()
        if (t && !/^(FADE|\[|@|#)/i.test(t)) drop.add(i)   // FADE IN·[크레딧:]·마커는 보존
      })
    }
  }
  lines = lines.filter((_, i) => !drop.has(i))
  // 헤딩끝 페이지번호 + 줄나눔 정리
  const res = []
  for (let l of lines) {
    let t = l.trim()
    if (/^#/.test(t)) { const c = collapseRepeatedRun(t); if (c !== t) { l = c; t = c } }   // 다중 그린 헤딩 접기
    if (/^#/.test(t) && /[가-힣\s)\]]\d{1,3}$/.test(t) && !/(19|20)\d{2}$/.test(t)) { l = l.replace(/(\d{1,3})\s*$/, '').replace(/\s+$/, ''); t = l.trim() }
    // TITLE:/SUPER:/CHYRON: 화면자막이 대사 블록에 붙지 않게 — [자막:] 마커로 바꾸고 앞뒤 빈 줄
    if (/^(TITLE|SUPER|CHYRON)\s*[:：]/i.test(t)) {
      const body = t.replace(/^(TITLE|SUPER|CHYRON)\s*[:：]\s*/i, '')
      if (res.length && res[res.length - 1] !== '') res.push('')
      res.push(koDoc ? `[자막: ${body}]` : `[SUPER: ${body}]`); res.push('')
      continue
    }
    if (t === '') { if (res.length && res[res.length - 1] === '') continue; res.push(''); continue }
    if (/^[#@]/.test(t) && res.length && res[res.length - 1] !== '') res.push('')
    res.push(l.replace(/\s+$/, ''))
  }
  while (res.length && res[0] === '') res.shift()
  while (res.length && res[res.length - 1] === '') res.pop()
  return reflowBody(res).join('\n')   // 끊긴 문장(@큐·#씬·빈줄 경계는 보존) 한 줄로
}

// 자동수정 전후 변화를 '코드로' 요약 (LLM 0). before/after 카드 표시용.
//   removed: 실제로 빠진 대표 줄(종류별) · joins: 줄나눔으로 합쳐진 before→after 예 · counts: 종류별 개수.
export function autofixChanges(text) {
  const is = detect(text)
  const lines = text.split('\n')
  const removed = []
  const add = (idxs, kind) => idxs.forEach(i => { const t = (lines[i] || '').trim(); if (t) removed.push({ kind, text: t }) })
  add(is.meta, 'AI 군말'); add(is.boiler, '머리말/꼬리말'); add(is.dupe, '겹친 줄'); add(is.repeat, '반복 단락')
  is.bilingual.forEach(d => { const t = (lines[d.start] || '').trim(); if (t) removed.push({ kind: '영한 중복', text: t }) })
  // 줄나눔(리플로우)으로 합쳐질 대표 예: 종결부호 없이 끝난 본문줄 + 다음 본문줄
  const joins = []
  for (let i = 1; i < lines.length && joins.length < 3; i++) {
    const a = lines[i - 1].trim(), b = lines[i].trim()
    if (a && b && !/^[#@(]/.test(a) && !/^[#@(]/.test(b) && !/[.!?…:;"'’”)\]]$/.test(a) && !/^[-•*]/.test(b)) {
      joins.push({ before: a + ' ⏎ ' + b, after: a + ' ' + b })
    }
  }
  const after = autofix(text)
  return {
    counts: summarize(text),
    removed: removed.slice(0, 6), removedTotal: removed.length,
    joins,
    beforeLines: lines.filter(l => l.trim()).length,
    afterLines: after.split('\n').filter(l => l.trim()).length,
    after,
  }
}

// 대사 블록에 붙은 지문을 빈 줄로 분리 (무료·결정적). 내용은 안 건드리고 줄만 띄움.
export function splitGluedAction(text) {
  const lines = text.split('\n')
  const glued = new Set(detect(text).glued)
  if (glued.size === 0) return text
  const out = []
  for (let i = 0; i < lines.length; i++) {
    // 지문 의심 줄 앞에 빈 줄 보장 → @큐 대사 블록에서 떨어져 나옴
    if (glued.has(i) && out.length && out[out.length - 1].trim() !== '') out.push('')
    out.push(lines[i])
  }
  return out.join('\n')
}

// 요약(배지용)
export function summarize(text) {
  const is = detect(text)
  return {
    meta: is.meta.length, boiler: is.boiler.length, dupe: is.dupe.length, repeat: is.repeat.length,
    headNum: is.headNum.length, bilingual: is.bilingual.length,
    dialog: is.dialog.length, struct: is.struct.length, miscue: is.miscue.length, glued: is.glued.length,
    spacing: is.spacing > is.lines * 0.15 ? is.spacing : 0,
    autofixable: is.meta.length + is.boiler.length + is.dupe.length + is.repeat.length + is.bilingual.length + is.headNum.length,
    review: is.dialog.length,
  }
}
