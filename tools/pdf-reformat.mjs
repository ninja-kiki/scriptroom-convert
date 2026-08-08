// PDF x좌표 기반 재포맷 — 들여쓰기로 씬/인물/대사/괄호/지문 분리.
// 줄나눔 뭉침(문제1) 작품을 PDF에서 다시 포맷. _formatted.txt만 새로 씀(번역은 realign으로 재정렬).
// 사용: node tools/pdf-reformat.mjs <PDF경로> [--write <출력경로>]   (--write 없으면 stdout 미리보기)
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, writeFileSync } from 'fs'

const pdfPath = process.argv[2]
const wi = process.argv.indexOf('--write')
const outPath = wi >= 0 ? process.argv[wi + 1] : null
if (!pdfPath) { console.error('PDF 경로 필요'); process.exit(1) }

// 볼드 효과를 텍스트 레이어에 다중으로 그린 PDF(스파이더맨 류) 대응 — 한 줄 안에서
// 같은 문자열이 연달아 반복되면 1회로 접는다. "EXT. HOUSE - DAYEXT. HOUSE - DAY...1111" → "EXT. HOUSE - DAY1"
function collapseRepeats(orig) {
  let s = orig, prev
  do { prev = s; s = s.replace(/(.{6,}?)\1{2,}/g, '$1') } while (s !== prev)
  // 긴 단위가 실제로 접혔을 때만 꼬리 동일숫자 다발(1111→1)도 접기 — 연도(2000) 같은 정상 숫자 보호
  return s !== orig ? s.replace(/(\d)\1{2,}\s*$/, '$1') : s
}

// 1) 줄 추출 (text, x=시작좌표, y) — y로 줄 묶고, 페이지번호/머리말 제거는 단순화
async function extractLines(path) {
  const data = new Uint8Array(readFileSync(path))
  const pdf = await getDocument({ data }).promise
  const lines = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    let items = (await page.getTextContent()).items.filter(i => 'str' in i)
    // 여백 씬/샷 번호 제거 — 촬영대본은 좌·우 여백에 "7A" 같은 씬번호를 본문과 같은 y에 찍는다.
    //   그대로 두면 줄 양끝에 "7A ... 7A"로 들러붙는다. 본문 왼쪽 시작선(bodyLeft)을 잡아,
    //   그보다 확실히 왼쪽(여백) 또는 페이지 오른쪽 끝에 있는 '순수 번호 토큰'만 아이템 단위로 버린다.
    const wordXs = items.filter(i => i.str.trim().length >= 4).map(i => i.transform[4])
    const bodyLeft = wordXs.length ? Math.min(...wordXs) : 0
    const isNumTok = s => /^[A-Z]{0,2}\d{1,3}[A-Z]?$/.test(s.trim())
    items = items.filter(it => {
      const ix = it.transform[4]
      if (!isNumTok(it.str)) return true
      return !(ix < bodyLeft - 10 || ix > bodyLeft + 430)   // 좌여백 또는 우여백의 번호 = 버림
    })
    let lastY = null, x = null, text = ''
    const push = () => { if (text.trim()) lines.push({ text: collapseRepeats(text.replace(/\s+/g, ' ').trim()), x, y: lastY, page: p }) }
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

// 1.5) 러닝 헤더/푸터 제거 — 여러 페이지에 반복 등장하는 동일 줄(페이지 꼬릿말·워터마크·출처 URL 등).
//   병합(soft-wrap) 전에 없애야 footer가 다음 페이지 본문과 한 줄로 붙는 오염을 막는다.
//   ★페이지 가장자리(앞뒤 2줄)만 후보로 본다. 위치 무관 전체빈도로만 판정하면, 내레이터 큐처럼
//     본문에 정당하게 반복되는 줄(예: casino "@ACE (V.O.)" 114회, 141페이지물 임계값 42 초과)이
//     러닝헤더로 오판돼 통째로 삭제되는 사고가 남. 러닝헤더/푸터는 항상 페이지 가장자리에만 있다.
function stripRepeatedBoiler(lines) {
  const norm = t => t.replace(/\s+/g, ' ').trim()
  // 러닝헤더에 페이지번호가 박혀 매 페이지 텍스트가 미묘하게 다른 경우(예: "The Martian Shooting Script 5.")
  // 정확일치로는 못 잡으므로, 빈도 판정용으로만 끝의 숫자·#번호 토큰을 지운 느슨한 키를 함께 쓴다.
  const loose = t => norm(t).replace(/\s*#?\d+[A-Za-z]?\.?\s*$/, '').trim()
  const byPage = new Map()
  lines.forEach((l, i) => { const arr = byPage.get(l.page) || []; arr.push(i); byPage.set(l.page, arr) })
  const edgeIdx = new Set()
  for (const idxs of byPage.values()) {
    const n = idxs.length
    idxs.forEach((li, i) => { if (i < 2 || i >= n - 2) edgeIdx.add(li) })
  }
  const maxPage = Math.max(1, ...lines.map(l => l.page))
  const freq = new Map(), looseFreq = new Map()
  lines.forEach((l, i) => {
    if (!edgeIdx.has(i)) return
    const k = norm(l.text)
    if (k.length >= 8) freq.set(k, (freq.get(k) || 0) + 1)
    const lk = loose(l.text)
    if (lk.length >= 8) looseFreq.set(lk, (looseFreq.get(lk) || 0) + 1)
  })
  const thr = Math.max(3, Math.floor(maxPage * 0.3))
  const boiler = [...freq].filter(([, c]) => c >= thr).map(([k]) => k)
  const looseBoiler = [...looseFreq].filter(([, c]) => c >= thr).map(([k]) => k)
  if (!boiler.length && !looseBoiler.length) return lines
  const boilerSet = new Set(boiler)
  const looseBoilerSet = new Set(looseBoiler)
  const longBoiler = boiler.filter(b => b.length >= 20)   // 본문 단어 오삭제 방지: 긴 것만 부분 제거
  const out = []
  lines.forEach((l, i) => {
    if (edgeIdx.has(i) && boilerSet.has(norm(l.text))) return   // 가장자리 boiler 줄만 통째 제거
    if (edgeIdx.has(i) && looseBoilerSet.has(loose(l.text))) return   // 페이지번호만 다른 반복 헤더도 통째 제거
    let text = l.text
    if (edgeIdx.has(i)) for (const b of longBoiler) if (text.includes(b)) text = text.split(b).join(' ').replace(/\s+/g, ' ').trim()  // 가장자리에 붙은 footer 부분만 제거
    if (text.trim()) out.push({ ...l, text })
  })
  return out
}

// 2) x밴드 자동 감지: 인물 큐는 '실제 큐 후보의 x 클러스터'로 잡는다(데이터 기반).
//   PDF마다 큐 들여쓰기가 달라, 지문여백+고정오프셋(예전 방식)은 큐 밴드가 어긋나 큐를 통째로 놓쳤다(big: 큐 x325인데 밴드 x525로 추정 → 큐 0).
function detectBands(lines) {
  const bx = x => Math.round(x / 5) * 5
  const freq = {}, cueFreq = {}
  for (const l of lines) {
    const k = bx(l.x); freq[k] = (freq[k] || 0) + 1
    if (isRealCue(l.text)) cueFreq[k] = (cueFreq[k] || 0) + 1
  }
  const xsByFreq = Object.entries(freq).map(([x, n]) => [+x, n]).sort((a, b) => b[1] - a[1])
  const cueSorted = Object.entries(cueFreq).map(([x, n]) => [+x, n]).sort((a, b) => b[1] - a[1])
  // 큐 후보가 한 x에 충분히 모이면(≥5) 그 클러스터를 큐 밴드로 신뢰
  if (cueSorted.length && cueSorted[0][1] >= 5) {
    const xChar = cueSorted[0][0]
    const character = xChar - 20                                       // 큐 클러스터 살짝 아래까지 큐로 인정
    const leftPeaks = xsByFreq.filter(([x]) => x < character - 30)     // 큐보다 확실히 왼쪽 = 지문/대사
    const xAction = leftPeaks.length ? Math.min(...leftPeaks.slice(0, 3).map(e => e[0])) : xChar - 220
    return { xAction, dialogue: Math.round((xAction + character) / 2), character, transition: xChar + 300 }
  }
  // 폴백: 큐 클러스터를 못 찾으면 예전 방식(지문 최빈 + 고정 오프셋)
  const xAction = Math.min(...xsByFreq.slice(0, 3).map(e => e[0]))
  return { xAction, dialogue: xAction + 50, character: xAction + 110, transition: xAction + 320 }
}

// ★INT/EXT 뒤 마침표는 선택 — 'EXT BAGHDAD STREET - DAWN'처럼 점 없이 쓰는 각본이 있다(허트 로커).
//   점을 필수로 두면 그런 각본은 씬을 통째로 놓쳐(39씬→13씬) 하나의 거대 씬으로 뭉개진다.
//   다만 'INTO'·'EXTREMELY' 같은 일반 단어 오탐을 막으려 뒤에 단어경계(공백/점)를 요구한다.
//   또 'EXT—CINEMA—NIGHT'처럼 em대시로 붙여 쓰는 각본도 있다(바스터즈). 이걸 놓치면 각본 전체가
//   두 덩어리로 뭉쳐 1,597줄이 미번역으로 남는다 — 구분자에 —·– 도 허용한다.
const SCENE_RE = /^(#?\s*)([A-Z]{0,2}\d{1,3}[A-Z]?\.?\s+)?(INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|(?:INT|EXT)(?:\.|\s|—|–)|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i
const OMITTED_RE = /^OMITTED\s*\d{0,4}[A-Za-z]?\s*\d{0,4}[A-Za-z]?\.?$/i
// 멀티버스/평행세계식 비표준 소제목("TAXES UNIVERSE: INT. X", "ALPHAVERSE: EXT. Y", "ROCK UNIVERSE:").
//   정식 INT./EXT.가 뒤에 붙기도, 안 붙기도 함 — 둘 다 씬 경계로 인식해야 통짜 초대형 씬(예: EEAAO 4만자 몽타주)이
//   안 생긴다. 안 쪼개면 번역 요청이 너무 커져 서버가 처리 중 죽는다(타임아웃이 아니라 fetch 자체 실패).
const UNIVERSE_RE = /^[A-Z][A-Z '.-]{1,30}VERSE:/
// 전환 지시어 — 콜론이 없거나(CUT TO BLACK) 변형(TRANSITION TO·FLASH BACK TO·FADE UP)인 형태가 실제로 많다.
//   좁게 잡으면 인물 큐로 오분류돼 '@CUT TO'·'@TRANSITION TO' 같은 가짜 화자가 생긴다(라이브러리 108건 발생).
const TRANS_RE = /^(?:(?:SMASH|MATCH|JUMP|HARD|QUICK)(?:\s+CUT)?\s+)?(?:CUT|DISSOLVE|FADE|WIPE|TRANSITION|FLASH(?:\s+BACK)?)?(?:\s*(?:TO|IN|OUT|UP|BACK))*(?:\s+BLACK|\s+WHITE)?\s*:?\s*$/i
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
  if (SCENE_RE.test(s) || isSlug(s) || OMITTED_RE.test(s) || UNIVERSE_RE.test(s)) return 'scene'
  if ((s && TRANS_RE.test(s)) || line.x >= b.transition) return 'transition'
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
  // ★대사에는 지금까지 마커가 없어 지문과 구분이 안 됐다(씬=#, 인물=@, 대사는 맨몸텍스트).
  //   그래서 파서(sync-sources parseBlocks)가 '@인물 다음 줄=대사'라는 위치 추론에만 의존했고,
  //   그 추론이 어긋나면 대사·지문이 한 블록으로 붙는 사고가 났다. 대사 줄 앞에 '- '를 붙여
  //   위치와 무관하게 확정적으로 식별되게 한다(씬/인물 마커와 동급의 구조 마커).
  const flush = () => { if (cur) { out.push(cur.type === 'dialogue' ? { ...cur, text: '- ' + cur.text } : cur); cur = null } }
  let prev = null
  let afterCue = false   // 방금 @인물 큐를 냈고 아직 그 대사를 못 만난 상태
  for (const line of lines) {
    let type = classify(line, b)
    const s = line.text.trim()
    if (!s) continue
    // 페이지번호/단독숫자/개정 샷번호(4A·6A·A19 등)/머리말 잡음 스킵.
    //   ★샷번호는 병합(soft-wrap) 전에 걷어내야 옆 문장에 "looks; 4A"처럼 들러붙지 않는다.
    if (/^\*?\s*[A-Z]{0,2}\d{1,4}[A-Z]?\.?\*?$/.test(s) || /^\(?(CONTINUED|CONT'D|MORE)\)?\s*:?\s*(\(\d+\))?\s*\d{0,4}[A-Za-z]?\s*\d{0,4}[A-Za-z]?\.?$/i.test(s) || s.length < 1) continue
    if (type === 'scene') { flush(); afterCue = false; out.push({ type, text: '# ' + s.replace(/^#\s*/, '').replace(/^[A-Z]{0,2}\d+[A-Z]?\.?\s+/, '').replace(/\s*[A-Z]{0,2}\d+[A-Z]?\.?\*?$/, '').trim() }) ; prev = line; continue }
    if (type === 'character') { flush(); afterCue = true; out.push({ type, text: '@' + s.replace(/[:：]\s*$/, '').trim() }); prev = line; continue }
    if (type === 'paren') { flush(); out.push({ type, text: s }); prev = line; continue }   // 괄호는 afterCue 유지(큐→(beat)→대사)
    // 전환지시어(CUT TO: 등)는 괄호로 감싸 독립된 한 줄로 — 리더가 괄호 지시문과 동일하게 흡수·렌더.
    if (type === 'transition') { flush(); afterCue = false; out.push({ type, text: '(' + s.replace(/^\(+|\)+$/g, '').trim() + ')' }); prev = line; continue }
    // ★큐 직후 첫 본문은 각본 구조상 무조건 대사 — x좌표 밴드 감지가 어긋난 작품(batman 등)에서
    //   대사가 action으로 오분류되던 것을 바로잡는다(대사·지문 붙음의 진짜 뿌리). 대사를 시작하면 afterCue 해제.
    if (afterCue && type === 'action') type = 'dialogue'
    // dialogue/action: 연속 줄 병합(soft wrap). 단 문단 갭(>1.6*lh)이나 타입 바뀌면 끊기
    const bigGap = prev && line.page === prev.page && (prev.y - line.y) > lh * 1.7
    if (cur && cur.type === type && !bigGap) cur.text += ' ' + s
    else { flush(); cur = { type, text: s } }
    if (type === 'dialogue') afterCue = false
    prev = line
  }
  flush()

  // 첫 씬 헤딩(#) 이전 = 타이틀 페이지 영역. 통째로 버리면 오프닝 지문·에피그래프·타이틀
  //   카드(TWBB 크레셴도, moneyball의 Bill James 인용, casino "TITLE: LAS VEGAS, 1980")까지
  //   날아간다. 그래서 '잡음(제목·by라인·초고/판권/주소)'만 버리고 '실질 내용'은 살린다.
  const META_RE = /written by|screenplay by|story by|teleplay by|based on|draft|shooting script|revision|confidential|propriet|property of|no portion|all rights|reproduced|distribut|prior written|©|copyright|WGA|registered|sole property|\bsuite\b|\bblvd\b|CA\s*\d{5}/i
  const CARD_RE = /^(TITLE:|SUPER:|IN\s*BLACK|OVER\s*BLACK|FADE\s*IN|BLACK\.|CHYRON|INTERTITLE)/i
  const keepPre = b => {
    const t = (b.text || '').trim()
    if (!t) return false
    if (b.type === 'transition') return true            // FADE IN: 등 전환지시어
    if (b.type !== 'action') return false               // pre 영역의 씬/인물/괄호는 대개 잡음 → 버림
    if (CARD_RE.test(t)) return true                    // TITLE:/SUPER:/IN BLACK 등 카드
    if (META_RE.test(t)) return false                   // 판권·크레딧·초고·주소 = 타이틀페이지 메타
    return t.length >= 45                               // 긴 산문 = 오프닝 지문/에피그래프
  }
  const firstScene = out.findIndex(b => b.type === 'scene')
  const body = firstScene > 0 ? [...out.slice(0, firstScene).filter(keepPre), ...out.slice(firstScene)] : out

  // 블록 사이 빈 줄 1개로 렌더 (scriptroom 규칙: 빈 줄=경계)
  return body.map(b => b.text).join('\n\n') + '\n'
}

let lines = await extractLines(pdfPath)
const before = lines.length
lines = stripRepeatedBoiler(lines)
if (lines.length < before) console.error(`러닝 헤더/푸터 제거: ${before - lines.length}줄`)
const bands = detectBands(lines)
console.error(`줄 ${lines.length} · x밴드: 지문<${bands.dialogue} 대사${bands.dialogue}-${bands.character} 인물≥${bands.character}`)
const formatted = build(lines, bands)
if (outPath) { writeFileSync(outPath, formatted); console.error(`→ ${outPath} (${formatted.split('\n\n').length} 블록)`) }
else console.log(formatted.split('\n').slice(0, 60).join('\n'))
