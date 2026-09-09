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
// 콜론·따옴표처럼 보이지만 다른 글자인 것들을 표준 문자로 맞춘다.
//   PDF에 U+A789(꞉) 같은 유사 글자가 섞이면 'TIME CUT TO꞉' 가 전환지시어 규칙에 안 걸려
//   가짜 화자(@TIME CUT TO꞉)가 된다(past-lives 56곳).
function normalizeLookalikes(s) {
  return s.replace(/[꞉︓：]/g, ':').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
          .replace(/[‒–—―]/g, m => m)   // 대시는 종류가 의미를 가지므로 그대로 둔다
}

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
  // 여백 씬/샷 번호 제거 — 촬영대본은 좌·우 여백에 "7A" 같은 씬번호를 본문과 같은 y에 찍는다.
  //   그대로 두면 줄 양끝에 "7A ... 7A"로 들러붙는다. 본문이 차지하는 x 구간을 잡고,
  //   그 바깥에 있는 '순수 번호 토큰'만 아이템 단위로 버린다.
  // ★기준을 '4글자 이상 토큰'으로 잡으면 안 된다 — 여백 번호 'A150' 이 딱 4글자라 그것이
  //   기준선이 되고, 그러면 자기 자신이 기준이니 여백 판정에 영원히 안 걸린다.
  //   연속된 알파벳 4자 이상을 요구하면 번호는 기준이 되지 못한다.
  // ★오른쪽 끝을 '왼쪽 기준 + 430' 으로 어림잡던 것도 못 쓴다. 왼쪽 기준이 조금만 달라져도
  //   오른쪽 상한이 통째로 밀려, 우여백 번호가 본문에 들러붙는다(니켈보이즈 'ARCHIVAL FOOTAGEV150').
  // ★페이지마다 따로 재도 안 된다 — 대사만 있는 페이지는 낱말 x 범위가 좁아(108~252) 본문 안의
  //   정상 토큰까지 바깥으로 몰린다. 문서 전체로 한 번에 잡아야 기준이 흔들리지 않는다.
  const pages = []
  const allWordXs = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = (await (await pdf.getPage(p)).getTextContent()).items.filter(i => 'str' in i)
    pages.push(items)
    for (const i of items) if (/[A-Za-z]{4,}/.test(i.str)) allWordXs.push(i.transform[4])
  }
  // ★오른쪽 끝은 최댓값이 아니라 상위 백분위로 잡는다. 최댓값은 우측으로 튄 몇 글자에 끌려간다
  //   — 니켈보이즈는 낱말 x가 98%까지 461인데 최댓값만 493이었고, 그 493 때문에 상한이 여백
  //   표시(502) 너머로 밀려 'ARCHIVAL FOOTAGE B150' 처럼 본문에 들러붙었다.
  allWordXs.sort((a, b) => a - b)
  const bodyLeft = allWordXs.length ? allWordXs[0] : 0
  const bodyRight = allWordXs.length ? allWordXs[Math.floor(allWordXs.length * 0.99)] : Infinity
  const isNumTok = s => /^[A-Z]{0,2}\d{1,3}[A-Z]?$/.test(s.trim())
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = pages[p - 1].filter(it => {
      const ix = it.transform[4]
      if (!isNumTok(it.str)) return true
      return !(ix < bodyLeft - 10 || ix > bodyRight + 20)   // 좌여백 또는 우여백의 번호 = 버림
    })
    let lastY = null, x = null, x2 = null, text = ''
    let lastIx = null, lastStr = null
    // x2 = 줄의 오른쪽 끝. 앞 줄이 오른쪽 여백까지 갔는지 알아야 '접힌 줄'과 '일부러 끊은 줄'을 가른다.
    const push = () => { if (text.trim()) lines.push({ text: normalizeLookalikes(collapseRepeats(text.replace(/\s+/g, ' ').trim())), x, x2, y: lastY, page: p }) }
    for (const it of items) {
      const ix = it.transform[4], iy = it.transform[5]
      if (lastY !== null && Math.abs(iy - lastY) > 3) { push(); text = ''; x = null; x2 = null; lastIx = null; lastStr = null }
      // ★볼드체를 흉내 내려고 같은 글자를 같은 자리에 그대로 겹쳐 찍는 PDF가 있다.
      //   양들의 침묵: 'CUT TO:' 가 x=392,y=419 에 완전히 같은 위치로 두 번 찍혀
      //   'CUT TO:CUT TO' 로 붙었다(뒤쪽은 살짝 다르게 잘려 collapseRepeats 의 3회
      //   반복 조건에도 안 걸렸다). 그러면 대문자 두 낱말처럼 보여 인물 큐로 오분류된다.
      //   같은 좌표(허용오차 0.5pt)에 같은 글자가 또 오면 겹침이므로 버린다.
      if (lastIx !== null && it.str === lastStr && Math.abs(ix - lastIx) < 0.5) continue
      if (x === null) x = ix
      const right = ix + (it.width || 0)
      if (x2 === null || right > x2) x2 = right
      text += it.str; lastY = iy; lastIx = ix; lastStr = it.str
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
    // ★'빈도 상위 3개 중 최소 x'로 지문 기준을 잡으면 안 된다. 상위 3개에 끼어든 소수 노이즈가
    //   그대로 기준이 된다 — 라이트하우스는 앞표지(PLAYERS 페이지) 여백 x=70(겨우 10줄)이
    //   지문 기준이 되는 바람에, 연쇄로 대사 경계가 102가 되고 진짜 지문(x=110, 1638줄)이
    //   통째로 대사로 분류됐다(지문 전체에 '- ' 대사 마커가 붙음).
    //   지문은 각본에서 가장 많은 줄을 차지하므로, 전체의 3% 미만인 봉우리는 기준에서 뺀다.
    //   ★'빈도 상위 3개 중 최소'라는 접근 자체가 취약했다. 상위 3개가 전부 대사 열인 각본에서는
    //   지문 열이 아예 후보에 못 들어간다(매그놀리아: 상위가 195/200/180인데 진짜 지문은 85).
    //   그래서 개수 제한을 없애고, '본문이라 할 만큼 큰 열'만 남긴 뒤 그중 가장 왼쪽을 지문으로 본다.
    //   기준은 5% — 3%로는 헤리디터리의 노이즈(156줄=3.2%)가 통과해 여전히 지문을 밀어냈다.
    //   ★'한 x좌표에 5% 이상'을 요구하면 좌표가 흔들리는 PDF에서 전부 탈락한다.
    //     파고는 대사가 155·156·157…162 로 흩어져 어느 하나도 4.7%를 못 넘었고,
    //     그래서 기준이 전부 탈락한 뒤 폴백(상위 3개)이 노이즈 x=16 을 지문으로 삼아
    //     밴드가 '지문<38'이 됐다 — 씬 13개·큐 154개로 각본이 통째로 뭉개졌다.
    //     열은 정확한 좌표가 아니라 구간이다. 붙어 있는 좌표를 한 열로 묶어서 센다.
    const clump = (entries, gap = 14) => {
      const asc = entries.slice().sort((a, b) => a[0] - b[0])
      const out = []
      for (const [x, n] of asc) {
        const last = out[out.length - 1]
        if (last && x - last.max <= gap) { last.max = x; last.n += n; if (n > last.peakN) { last.peakN = n; last.x = x } }
        else out.push({ x, max: x, n, peakN: n })
      }
      return out
    }
    const MIN_SHARE = lines.length * 0.05
    const leftCols = clump(leftPeaks)
    const solidLeft = leftCols.filter(c => c.n >= MIN_SHARE)
    const basis = solidLeft.length ? solidLeft : leftCols.sort((a, b) => b.n - a.n).slice(0, 3)
    const xAction = basis.length ? Math.min(...basis.map(c => c.x)) : xChar - 220
    // ★대사 경계는 '지문과 인물의 중점'이라는 기하학적 가정으로 정해선 안 된다.
    //   인물 큐는 데이터(클러스터)로 찾으면서 대사만 중점으로 두다 보니, 대사 열이 그 중점보다
    //   조금이라도 왼쪽인 각본에서 대사 전체가 지문으로 떨어졌다
    //   (어 스타 이즈 본: 대사 실제 x=202.9인데 중점이 205 → 2.1pt 차이로 전멸).
    //   대사도 자기 열(봉우리)을 만드므로 그걸 직접 찾고, 경계는 그 봉우리 살짝 아래로 잡는다.
    //   대사 열도 같은 이유로 묶어서 센다(파고는 흩어져 있어 낱개로는 20줄 문턱을 못 넘었다).
    const midCols = clump(Object.entries(freq).map(([x, n]) => [+x, n])
      .filter(([x]) => x >= xAction + 40 && x < character))
      .filter(c => c.n >= 20).sort((a, b) => b.n - a.n)
    const dialogue = midCols.length
      ? Math.min(midCols[0].x - 8, Math.round((xAction + character) / 2))   // 봉우리 아래로. 중점보다 위로는 올리지 않는다
      : Math.round((xAction + character) / 2)                               // 대사 열을 못 찾으면 기존 방식
    return { xAction, dialogue, character, transition: xChar + 300 }
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
const SCENE_RE = /^(#?\s*)([A-Z]{0,2}\d{1,3}[A-Z]?\.?\s+)?(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|(?:INT|EXT)(?:\.|:|\s|—|–)|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i
const OMITTED_RE = /^OMITTED\s*\d{0,4}[A-Za-z]?\s*\d{0,4}[A-Za-z]?\.?$/i
// 멀티버스/평행세계식 비표준 소제목("TAXES UNIVERSE: INT. X", "ALPHAVERSE: EXT. Y", "ROCK UNIVERSE:").
//   정식 INT./EXT.가 뒤에 붙기도, 안 붙기도 함 — 둘 다 씬 경계로 인식해야 통짜 초대형 씬(예: EEAAO 4만자 몽타주)이
//   안 생긴다. 안 쪼개면 번역 요청이 너무 커져 서버가 처리 중 죽는다(타임아웃이 아니라 fetch 자체 실패).
const UNIVERSE_RE = /^[A-Z][A-Z '.-]{1,30}VERSE:/
// 전환 지시어 — 콜론이 없거나(CUT TO BLACK) 변형(TRANSITION TO·FLASH BACK TO·FADE UP)인 형태가 실제로 많다.
//   좁게 잡으면 인물 큐로 오분류돼 '@CUT TO'·'@TRANSITION TO' 같은 가짜 화자가 생긴다(라이브러리 108건 발생).
//   ★그런데 이 틀은 조각이 전부 '있어도 되고 없어도 되는' 것이라 사실상 아무거나 통과했다.
//   'TOM' 이 'TO' + 남는 글자 하나([A-Z]?)로 맞아떨어져 전환 지시어가 됐고, 인물 큐 121개가
//   통째로 괄호에 갇혔다(리플리 — 톰이 주인공이다). 같은 식으로 'ONE'(ON+E)·'BACKS'·'OUTS'도 걸린다.
//   그래서 틀에 맞는지만 보지 않고, '전환을 뜻하는 낱말이 실제로 들어 있거나 콜론으로 끝나거나'를
//   함께 요구한다 — 'BACK TO:' 처럼 낱말이 없는 형태는 콜론이 대신 증명한다.
const TRANS_SHAPE = /^(?:(?:SMASH|MATCH|JUMP|HARD|QUICK|TIME|SLAM|SNAP|ROTATE|LONG)(?:\s+CUT)?\s+)?(?:CUT|DISSOLVE|FADE|WIPE|TRANSITION|FLASH(?:\s+BACK)?)?(?:\s*(?:TO|IN|OUT|UP|BACK|ON))*(?:\s+BLACK|\s+WHITE)?\s*:?\s*\d{0,4}[A-Z]?\s*\*?\s*$/i
const TRANS_WORD = /\b(CUT|DISSOLVE|FADE|WIPE|TRANSITION|FLASH)\b/i
const TRANS_COLON = /:\s*\d{0,4}[A-Z]?\s*\*?\s*$/
const TRANS_RE = { test: (s) => TRANS_SHAPE.test(s) && (TRANS_WORD.test(s) || TRANS_COLON.test(s)) }
const TIME = /\b(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|LATER|EARLIER|CONTINUOUS|MOMENTS|SAME|SUNSET|SUNRISE)\b/
const isSlug = (s) => { if (!/\s[-–—]\s/.test(s) || s.length > 70) return false; const L = s.replace(/[^A-Za-z]/g, ''), U = s.replace(/[^A-Z]/g, ''); return L.length >= 3 && U.length / L.length >= 0.85 && TIME.test(s.split(/\s[-–—]\s/).pop()) }
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
  // 오른쪽 여백과 글자폭 — '앞 줄이 여백까지 갔나'를 재려면 기준이 있어야 한다.
  //   여백은 최댓값이 아니라 상위 8% 지점으로 잡는다(들쭉날쭉한 한두 줄에 기준이 끌려가지 않게).
  //   지문과 대사는 열 너비가 다르므로 따로 잡는다.
  //   ★처음엔 줄의 오른쪽 끝 좌표(x2)로 쟀는데, 폰트를 못 읽는 PDF에서 글자 폭이 못 미더워
  //     멀쩡히 찬 대사 줄을 '짧다'고 오판했다(오펜하이머: 문장 중간 끊김 16→48).
  //     글자 수로 재면 폰트 메트릭에 기대지 않는다 — 고정폭 서체라 글자 수가 곧 줄 길이다.
  const pct = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))] }
  const lenAction = [], lenDialogue = []
  for (const l of lines) {
    if (l.x >= b.character) continue                                  // 인물 큐는 열 너비 기준이 아니다
    ;(l.x >= b.dialogue ? lenDialogue : lenAction).push(l.text.length)
  }
  const fullAction = pct(lenAction, 0.92), fullDialogue = pct(lenDialogue, 0.92)

  const out = []
  let cur = null  // { type, text }
  let seenScene = false   // 첫 씬 헤딩을 만났나 — 서두와 본문을 가른다
  // ★대사에는 지금까지 마커가 없어 지문과 구분이 안 됐다(씬=#, 인물=@, 대사는 맨몸텍스트).
  //   그래서 파서(sync-sources parseBlocks)가 '@인물 다음 줄=대사'라는 위치 추론에만 의존했고,
  //   그 추론이 어긋나면 대사·지문이 한 블록으로 붙는 사고가 났다. 대사 줄 앞에 '- '를 붙여
  //   위치와 무관하게 확정적으로 식별되게 한다(씬/인물 마커와 동급의 구조 마커).
  // ★'<번호>. <장소>. <시간>. 지문…' 처럼 씬 제목과 지문이 한 줄에 붙는 각본이 있다
  //   (룸 넥스트 도어: '1. A BOOKSTORE IN N.Y. DAY There is a long line…' — 105곳).
  //   INT./EXT. 가 없거나 장소 뒤에 오므로 기존 씬 규칙에 안 걸리고, 각본 전체가 1~3씬으로 뭉갰다.
  //   다만 이런 형태를 무조건 씬으로 보면 위험하므로, '이 문서에서 실제로 자주 쓰이는 관행인지'
  //   (10회 이상) 세어보고 그럴 때만 적용한다. 각본마다 표준이 다르니 문서 스스로 증명하게 한다.
  //   헤딩이 독립된 줄일 때('3. BY THE RIVER. DAY.')와 지문이 붙어 있을 때
  //   ('1. A BOOKSTORE IN N.Y. DAY There is a long line…') 두 형태를 모두 잡는다.
  const NUM_HEAD = /^(\d{1,3}[A-Za-z]?\.\s+)([A-Z][A-Z0-9 ,.'’\/&()-]{4,})$/          // 독립 줄
  const NUM_SPLIT = /^(\d{1,3}[A-Za-z]?\.\s+)([A-Z][A-Z0-9 ,.'’\/&()-]{4,}?)(?=\s+[A-Z][a-z])/  // 지문 붙음
  const numberedCount = lines.filter(l => { const x = l.text.trim(); return NUM_HEAD.test(x) || NUM_SPLIT.test(x) }).length
  const useNumbered = numberedCount >= 10

  const flush = () => { if (cur) { out.push(cur.type === 'dialogue' ? { ...cur, text: '- ' + cur.text } : cur); cur = null } }
  let prev = null
  let afterCue = false   // 방금 @인물 큐를 냈고 아직 그 대사를 못 만난 상태
  // ★대사 x좌표가 자동 감지 밴드 경계에서 몇 포인트 어긋나는 작품이 실제로 있다(어 스타 이즈 본: x=202.9,
  //   밴드는 205~280 — 2.1pt 차이로 지문 취급됨). 큐 직후 첫 줄은 afterCue 구제로 살아나지만, 대사 중간에
  //   원본 PDF 줄간격이 벌어져 문단이 한 번 더 끊기면(bigGap) 그 다음 조각은 이미 afterCue가 꺼진 뒤라
  //   구제받지 못하고 지문으로 떨어진다 — 라이브러리 91편에서 6,700건 발생.
  //   같은 대사가 계속되는 동안의 x좌표를 기억해두고, 그 근방(±6pt)에서 또 나오는 action 판정 줄은
  //   '이어지는 대사'로 구제한다. 새 씬/큐/전환이 나오면 리셋해 무관한 뒷부분 지문까지 삼키지 않는다.
  let lastDialogueX = null
  // 각 줄의 '다음 내용 줄'을 미리 구해 둔다 — 페이지 끝 고아 큐를 가려내는 데 쓴다.
  const nextContent = new Array(lines.length).fill(null)
  for (let k = lines.length - 2; k >= 0; k--) nextContent[k] = lines[k + 1]
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    let type = classify(line, b)
    const s = line.text.trim()
    if (!s) continue
    // 페이지번호/단독숫자/개정 샷번호(4A·6A·A19 등)/머리말 잡음 스킵.
    //   ★샷번호는 병합(soft-wrap) 전에 걷어내야 옆 문장에 "looks; 4A"처럼 들러붙지 않는다.
    // 대시로 감싼 페이지 번호(—2—, –14–)도 페이지 표시다 — 숫자만 있는 줄만 걸러선 안 잡힌다(TÁR 344곳)
    if (/^[—–-]\s*\d{1,4}\s*[—–-]$/.test(s)) continue
    // 타이틀페이지 쪽번호는 소문자 로마숫자다('ii.'). 숫자 규칙에 안 걸려 본문에 섞여 들어왔다
    // (라이트하우스: 'Audio mix: Mono ii. BLACK.' — 오디오 표기와 첫 샷 사이에 쪽번호가 박혔다).
    // ★글자 목록으로 '[ivxlcdm]{1,7}' 이라고 쓰면 안 된다. 그 글자들로만 된 진짜 영어 낱말이
    //   통째로 걸린다 — ill. · mill. · civil. · mimic. · vivid. 가 전부 매치된다(대사가 사라진다).
    //   로마숫자 문법 자체로 판정하고(ill·civil·mimic 은 문법상 로마숫자가 아니다),
    //   서두 페이지에만 적용한다 — 이 번호는 본문 시작 전에만 쓰인다.
    if (line.page <= 8 && /^(?=[ivxlcdm])m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})\.$/.test(s)) continue
    // ★'CONTINUED' 앞에 씬번호가 붙는 판형이 있다('5 CONTINUED: 5' — 캐치 미 이프 유 캔).
    //   정규식이 CONTINUED로 시작해야만 잡아서, 숫자가 앞에 붙으면 못 걸렀다.
    //   그러면 본문으로 흘러가 대문자 두 낱말처럼 보여 인물 큐로 오분류된다.
    if (/^\*?\s*[A-Z]{0,2}\d{1,4}[A-Z]?\.?\*?$/.test(s) || /^\(?\d{0,4}[A-Za-z]?\s*(CONTINUED|CONT'D|MORE)\)?\s*:?\s*(\(\d+\))?\s*\d{0,4}[A-Za-z]?\s*\d{0,4}[A-Za-z]?\.?$/i.test(s) || s.length < 1) continue
    // 번호형 헤딩 각본: '3. BY THE RIVER. DAY. Ingrid walks…' 를 헤딩과 지문으로 가른다.
    //   가르는 자리는 '대문자 덩어리가 끝나고 첫 일반 문장이 시작되는 곳'(Capitalized+소문자).
    if (useNumbered) {
      const nh = s.match(NUM_HEAD)
      const ns2 = nh ? null : s.match(NUM_SPLIT)
      if (nh || ns2) {
        flush(); afterCue = false; lastDialogueX = null; seenScene = true
        const head = (nh ? nh[2] : ns2[2]).trim().replace(/[.,\s]+$/, '')
        out.push({ type: 'scene', text: '# ' + head })
        if (ns2) { const restText = s.slice(ns2[0].length).trim(); if (restText) cur = { type: 'action', text: restText } }
        prev = line; continue
      }
    }
    if (type === 'scene') {
      // 촬영대본은 씬 번호를 좌·우 여백에 똑같이 찍는다('105        105'). 앞뒤 번호를 둘 다 떼면
      // 남는 게 없다 — 그런데 예전엔 그대로 '# '(내용 없는 헤딩)를 뱉었다.
      // ★그 빈 헤딩이 번역기까지 흘러가면 모델이 번역 대신 메타 응답을 낸다
      //   ('# 생략' · '입력이 `# ` 뿐이므로 그대로 출력합니다'). 그러면 씬 수가 늘어(라이트하우스 115→119)
      //   --resume 의 씬 정렬이 깨지고, 이어서 채우려던 재시도가 전부 안전장치에 걸려 헛돈다.
      // 번호만 있는 줄이라 버릴 내용이 없으므로, 빈 헤딩은 만들지 않고 그냥 넘긴다.
      // ('105 105' 같은 변형을 스킵 규칙에 하나씩 더하는 대신, '내용 없는 헤딩은 헤딩이 아니다'로 막는다.)
      // ★뒤쪽 씬번호를 뗄 때 '[A-Z]{0,2}\d+' 를 공백 없이 허용하면 낱말의 끝 글자를 먹는다.
      //   'OMITTED105'(번호가 낱말에 붙어 들어온 형태)에서 'ED105'를 떼어 'OMITT'를 남겼고,
      //   그러면 아래 삭제씬 판정에 안 걸린다. 그 뒤 strip-script-headers 가 'OMIT'만 지워
      //   '# T' 라는 가짜 헤딩이 됐다(니켈보이즈 8곳). 그게 번역기로 가면 또 '# 생략'이 된다.
      //   'A105' 꼴은 공백 뒤에서만 인정하고, 숫자만인 꼬리는 붙어 있어도 뗀다.
      const head = s.replace(/^#\s*/, '').replace(/^[A-Z]{0,2}\d+[A-Z]?\.?\s+/, '')
        .replace(/\s+[A-Z]{1,2}\d+[A-Z]?\.?\*?$/, '').replace(/\s*\d+[A-Z]?\.?\*?$/, '').trim()
      if (!head) { prev = line; continue }
      // 삭제된 씬('105 OMITTED 105')은 제작 기록일 뿐 읽을 내용이 없다. 번역기까지 보내면
      // 모델이 성실하게 '# 생략'으로 옮기는데, 그러면 원문 쪽에서 이 줄을 지우는 후처리와 어긋나
      // 원문/번역 씬 수가 갈린다(머드바운드 176/163, 니켈보이즈 146/134).
      // 장소가 붙은 헤딩('105 OMITTED - INT. HOUSE')은 진짜 씬이므로 건드리지 않는다.
      if (/^(?:SCENES?\s+)?(?:OMIT(?:TED)?|DELETED)\.?$/i.test(head)) { prev = line; continue }
      flush(); afterCue = false; lastDialogueX = null; seenScene = true
      // ★씬 헤딩이 길면 PDF에서 두 줄로 접힌다. 두 줄 다 헤딩으로 판정되니 그대로 두면
      //   유령 씬이 하나 생긴다(니켈보이즈: 'INT. RESTAURANT KITCHEN - HOTEL RICHMOND -
      //   TALLAHASSEE -' 와 '- DAY (D6)' 가 별개 씬이 됐고, 뒤쪽은 본문 없는 껍데기였다).
      //   앞 헤딩이 대시로 끊긴 채 끝났으면 그건 미완성이라는 뜻이다 — 이어붙인다.
      const last = out[out.length - 1]
      if (last && last.type === 'scene' && /[-–—]\s*$/.test(last.text)) {
        last.text = last.text.replace(/\s*[-–—]\s*$/, '') + ' - ' + head.replace(/^\s*[-–—]\s*/, '')
        prev = line; continue
      }
      out.push({ type, text: '# ' + head }); prev = line; continue
    }
    if (type === 'character') {
      flush(); afterCue = true; lastDialogueX = null
      const name = s.replace(/[:：]\s*$/, '').trim()
      // ★괄호로만 된 줄은 사람이 아니다. 인물 이름 아래에 딸린 표시다 —
      //   계속 표시 '(CONT'D)' · '(CON'T)', 말하는 언어 '(ENGLISH)' · '(FRENCH)' 같은 것들.
      //   이게 별개 인물로 잡히면 앞 큐가 대사 없는 껍데기가 된다. 리더에서 '이름만 있고
      //   대사가 없는' 바로 그 모양이고, 바스터즈 한 편에서만 61곳이었다.
      //   ★낱말을 나열해 잡으려다 절반을 놓쳤다 — 아포스트로피가 곧은 것(')과 곱슬한 것(’)
      //     두 가지로 와서 CON'T 만 적었더니 11곳만 걸렸다. 목록을 늘리는 대신
      //     '괄호뿐이면 사람이 아니다'라는 사실 자체로 판정한다.
      //   버리지 않고 괄호 지시문으로 남긴다 — 특히 언어 표시는 번역에 꼭 필요하다
      //   (어느 언어로 하는 말인지 모르면 원어로 둬야 할 대사를 한국어로 옮겨버린다).
      const last = out[out.length - 1]
      if (/^\(.*\)$/.test(name) && last && last.type === 'character') {
        out.push({ type: 'paren', text: name }); prev = line; continue
      }
      // ★페이지 맨 끝에 대사 없이 이름만 남은 큐가 있다. 각본 편집기가 쪽을 넘기면서
      //   큐만 남기고 대사는 다음 쪽으로 보낸 흔적인데, 다음 쪽은 대사가 아니라 다른 인물의
      //   큐로 시작한다 — 즉 그 이름에 딸린 대사는 애초에 없다(1917 14쪽 'ERINMORE (CONT'D)',
      //   15쪽은 'BLAKE'의 대사로 시작). 원본에 있는 흔적이지 우리가 잃은 게 아니다.
      //   그대로 두면 리더에 '이름만 있고 대사가 없는' 자리로 보인다 — 읽는 사람은
      //   대사가 사라졌다고 오해하고, 실제 손실과 구분할 수도 없다. 그래서 버린다.
      //   ★다음 쪽이 대사로 시작하면 그 대사가 이 인물의 것이므로 절대 버리면 안 된다.
      const nxt = nextContent[li]
      if (nxt && nxt.page !== line.page && classify(nxt, b) !== 'dialogue') { prev = line; continue }
      if (!nxt) { prev = line; continue }
      out.push({ type, text: '@' + name }); prev = line; continue
    }
    if (type === 'paren') { flush(); out.push({ type, text: s }); prev = line; continue }   // 괄호는 afterCue·lastDialogueX 유지(큐→(beat)→대사)
    // 전환지시어(CUT TO: 등)는 괄호로 감싸 독립된 한 줄로 — 리더가 괄호 지시문과 동일하게 흡수·렌더.
    if (type === 'transition') { flush(); afterCue = false; lastDialogueX = null; out.push({ type, text: '(' + s.replace(/^\(+|\)+$/g, '').trim() + ')' }); prev = line; continue }
    // ★큐 직후 첫 본문은 각본 구조상 무조건 대사 — x좌표 밴드 감지가 어긋난 작품(batman 등)에서
    //   대사가 action으로 오분류되던 것을 바로잡는다(대사·지문 붙음의 진짜 뿌리). 대사를 시작하면 afterCue 해제.
    if (afterCue && type === 'action') type = 'dialogue'
    // dialogue/action: 연속 줄 병합(soft wrap). 단 문단 갭·페이지 경계·짧은 앞줄이면 끊는다.
    // ★페이지가 바뀌면 세로 간격을 잴 수 없다. 예전 코드는 그걸 '간격 없음'으로 쳐서(page 비교가
    //   조건 안에 있었다) 앞 페이지 마지막 줄과 다음 페이지 첫 줄을 한 문단으로 붙였다.
    //   라이트하우스에서 1쪽 맨 아래 판권 줄이 2쪽 맨 위 'PLAYERS:'와 한 덩어리가 됐고,
    //   그 덩어리에 '©'가 있으니 타이틀페이지 메타로 판정돼 등장인물 소개까지 통째로 버려졌다.
    //   못 재는 걸 '간격 없음'으로 치면 안 된다 — 페이지가 바뀌면 끊는다.
    const pageBreak = prev && line.page !== prev.page
    const bigGap = prev && line.page === prev.page && (prev.y - line.y) > lh * 1.7
    // ★'접힌 줄'과 '일부러 끊은 줄'을 가른다. 조판의 사실: 문단이 접히면 앞 줄은 오른쪽 여백까지
    //   찬다. 앞 줄이 여백에서 한참 못 미쳐 끝났으면 그건 글쓴이가 거기서 끊은 것이다.
    //   예전엔 이걸 안 봐서 서두가 통째로 한 줄이 됐다 — 'NOTE:' + 'This film must be…' +
    //   'Aspect ratio: 1.19:1' + 'Audio mix: Mono' 가 전부 한 문단. PDF와 모양이 달라진다.
    //   여유는 20자 — 다음 줄로 넘어가는 낱말은 영어에서 그보다 길기 어렵다(정상 접힘은 안 끊긴다).
    // ★본문에는 적용하지 않는다. 본문은 열 너비대로 접히는 게 규칙이라 '짧은 줄'을 끊음으로 보면
    //   멀쩡한 대사가 문장 중간에서 잘린다(라이트하우스 대사 다수, 오펜하이머 이중대사 판형).
    //   서두는 다르다 — 자유 형식이라 접힘 가정 자체가 성립하지 않고, 실제로 여기서만 문제가 났다:
    //   'SETTING:' + 'Somewhere far off…' 이 한 줄이 되고 'NOTE:' 아래 항목들이 전부 뭉쳤다.
    //   범위를 서두로 좁히면 본문 회귀 위험이 없다.
    const full = type === 'dialogue' ? fullDialogue : fullAction
    const shortPrev = !seenScene && prev && full != null && (full - prev.text.length) > 20
    if (cur && cur.type === type && !bigGap && !pageBreak && !shortPrev) cur.text += ' ' + s
    else { flush(); cur = { type, text: s } }
    if (type === 'dialogue') { afterCue = false; lastDialogueX = line.x }
    prev = line
  }
  flush()

  // 첫 씬 헤딩(#) 이전 = 타이틀 페이지 영역. 통째로 버리면 오프닝 지문·에피그래프·타이틀
  //   카드(TWBB 크레셴도, moneyball의 Bill James 인용, casino "TITLE: LAS VEGAS, 1980")까지
  //   날아간다. 그래서 '잡음(제목·by라인·초고/판권/주소)'만 버리고 '실질 내용'은 살린다.
  const META_RE = /written by|screenplay by|story by|teleplay by|based on|draft|shooting script|revision|confidential|propriet|property of|no portion|all rights|reproduced|distribut|prior written|©|copyright|WGA|registered|sole property|\bsuite\b|\bblvd\b|CA\s*\d{5}/i
  // 개정 색상표 — 'Blue - 2,5,6,8,12-15... Pink - 2,3,3A...' 처럼 개정된 씬 번호만 잔뜩 나열한 줄.
  //   내용이 아니라 제작 정보이고, 번역기에 넘기면 숫자 나열을 그대로 옮기려 든다(메멘토).
  const REVLIST_RE = /^(?:\s*(?:White|Blue|Pink|Yellow|Green|Goldenrod|Buff|Salmon|Cherry|Tan)\s*[-–—]\s*[\d,\sA-]{6,}){2,}$/i
  const CARD_RE = /^(TITLE:|SUPER:|IN\s*BLACK|OVER\s*BLACK|FADE\s*IN|BLACK\.|CHYRON|INTERTITLE)/i
  const keepPre = b => {
    const t = (b.text || '').trim()
    if (!t) return false
    if (b.type === 'transition') return true            // FADE IN: 등 전환지시어
    if (b.type !== 'action') return false               // pre 영역의 씬/인물/괄호는 대개 잡음 → 버림
    if (CARD_RE.test(t)) return true                    // TITLE:/SUPER:/IN BLACK 등 카드
    if (META_RE.test(t)) return false                   // 판권·크레딧·초고·주소 = 타이틀페이지 메타
    if (REVLIST_RE.test(t)) return false                // 개정 색상표(Blue - 2,5,6... Pink - 3,3A...)
    // ★예전엔 여기서 't.length >= 45' 로 걸렀다. '긴 산문만 본문'이라는 뜻이었는데,
    //   각본 본문을 글자 수로 판정하는 셈이라 서두 정보가 통째로 사라졌다(라이트하우스):
    //     'PLAYERS:'(8자) · 'SETTING:'(8자) · 'NOTE:'(5자) · 'Aspect ratio: 1.19:1'(20자)
    //     'OLD, a crusty lighthouse keeper. His boss.'(42자) — 3자 차이로 등장인물 소개가 날아갔다
    //     'The rumble of a lonely FOGHORN. Low. Faint.'(43자) — 2자 차이로 오프닝 지문이 날아갔다
    //   판권·크레딧·주소는 위의 META_RE 가 이미 걸러낸다. 그 위에 길이 규칙을 더 얹을 이유가 없다.
    //   남기는 쪽이 안전하다 — 타이틀 몇 줄이 더 붙는 건 무해하지만, 본문이 사라지는 건 치명적이다.
    return true
  }
  const firstScene = out.findIndex(b => b.type === 'scene')
  // ★타이틀 페이지 정리는 '진짜 타이틀 페이지'에만 적용해야 한다.
  //   씬 인식이 실패해 첫 헤딩이 한참 뒤에 잡히면, 그 앞 전체가 타이틀 페이지로 간주돼
  //   대사·화자가 통째로 버려진다(새터데이 나이트: 첫 헤딩이 747번째 블록 → 각본 절반인
  //   67,000자가 사라졌다). 타이틀 페이지는 길어야 앞부분 몇십 블록이므로 그 범위로 한정한다.
  const PRE_LIMIT = Math.min(40, Math.floor(out.length * 0.05))
  const body = (firstScene > 0 && firstScene <= PRE_LIMIT)
    ? [...out.slice(0, firstScene).filter(keepPre), ...out.slice(firstScene)]
    : out

  // 블록 사이 빈 줄 1개로 렌더 (scriptroom 규칙: 빈 줄=경계)
  return body.map(b => b.text).join('\n\n') + '\n'
}

// ★재OCR 결과를 받아들이는 입구.
//   스캔 각본은 PDF에 박힌 텍스트 레이어 자체가 깨져 있어(네트워크: 'HOWARD'→'HOWAP.O')
//   여기서 아무리 잘 골라도 소용이 없다. ocr-extract.mjs 로 이미지를 다시 읽어 만든
//   줄 목록을 --lines 로 넘기면, 그 뒤 밴드 감지·분류·병합은 전부 그대로 쓴다.
const linesIdx = process.argv.indexOf('--lines')
let lines
if (linesIdx >= 0) {
  const raw = readFileSync(process.argv[linesIdx + 1], 'utf8').split('\n')
  lines = []
  for (const r of raw) {
    if (!r.trim()) continue
    const c = r.split('\t')
    if (c.length < 4) continue
    const text = normalizeLookalikes(collapseRepeats(c.slice(3).join('\t').replace(/\s+/g, ' ').trim()))
    if (text) lines.push({ text, x: +c[1], x2: null, y: +c[2], page: +c[0] })
  }
  console.error(`재OCR 줄 목록 ${lines.length}줄 읽음`)
} else {
  lines = await extractLines(pdfPath)
}
const before = lines.length
lines = stripRepeatedBoiler(lines)
if (lines.length < before) console.error(`러닝 헤더/푸터 제거: ${before - lines.length}줄`)
const bands = detectBands(lines)
console.error(`줄 ${lines.length} · x밴드: 지문<${bands.dialogue} 대사${bands.dialogue}-${bands.character} 인물≥${bands.character}`)
const formatted = build(lines, bands)
if (outPath) { writeFileSync(outPath, formatted); console.error(`→ ${outPath} (${formatted.split('\n\n').length} 블록)`) }
else console.log(formatted.split('\n').slice(0, 60).join('\n'))
