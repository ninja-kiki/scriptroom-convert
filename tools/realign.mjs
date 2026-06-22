// EN↔KO 1:1 정렬 복구 배치기 (재번역 금지 · 재블록화 + 갭필)
//
// scriptroom은 _formatted(EN)·_translated(KO)를 블록으로 쪼개 위치로 짝짓는다.
// 번역이 EN엔 없는 빈 줄(문단 분할)을 KO에 넣어 블록 수가 어긋나면 전부 밀린다.
// 이 스크립트는 마커(#·@·괄호)로 앵커 정렬한 뒤, 마커 사이 KO 블록을 EN 블록 수에
// 맞춰 재그룹화한다. EN에만 있는 구간(미번역)은 --gapfill일 때만 번역으로 채운다.
//
// 사용:
//   node tools/realign.mjs                 # 전체 점검(쓰기 안 함, 리포트만)
//   node tools/realign.mjs --write         # *_formatted.aligned.txt / *_translated.aligned.txt 생성
//   node tools/realign.mjs --write --overwrite   # 원본 덮어쓰기(.bak 백업)
//   node tools/realign.mjs --only=baby-driver --write
//   node tools/realign.mjs --gapfill --model=claude-sonnet-4-6 --write   # 미번역 구간 채움(서버 3001 필요)
//
// 옵션: --dir=<content경로> (기본 /Users/hojun/Projects/scriptroom/content)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }

const CONTENT_DIR = opt('dir', '/Users/hojun/Projects/scriptroom/content')
const WRITE = flag('write')
const OVERWRITE = flag('overwrite')
const GAPFILL = flag('gapfill')
const MODEL = opt('model', 'claude-sonnet-4-6')
const ONLY = opt('only', null)
const SERVER = opt('server', 'http://localhost:3001')

// ── scriptroom parseBlocks 규칙 그대로 ───────────────────────────────
// 블록 타입: scene / character / paren / dialogue / action
const isScene = (l) => /^#\s*(INT|EXT|내부|외부)/i.test(l.trim())
const isCharacter = (l) => /^@/.test(l.trim())
const isParen = (l) => { const t = l.trim(); return t.startsWith('(') && t.endsWith(')') }

// @가 진짜 인물 큐인가 — 짧은 이름, 문장부호 끝 아님, 관사·카메라라벨·조각 아님.
// 가짜(지문·외침·카메라라벨)면 @를 떼고 일반 지문으로 강등 (scriptroom 가짜 화자 방지).
function looksLikeRealCue(line) {
  let s = line.trim().replace(/^@\s*/, '').trim()
  s = s.replace(/\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT|MORE|소리|필터|화면\s*밖)\.?\)\s*$/i, '').trim()  // 허용 수식어 제거
  if (!s || s.length > 28) return false
  if (/[.,!?;…·]$/.test(s)) return false                                         // 문장부호 끝 = 조각/외침/지문
  if (/^(A|AN)\s/i.test(s)) return false                                         // "A MAN'S VOICE" 류 묘사 (THE는 인물명 가능성 있어 유지)
  if (s.split(/\s+/).length > 4) return false                                    // 5단어 이상 = 묘사
  // 카메라/장소/지시/표기 라벨로 시작 (관사 규칙은 인물명 오인 위험 커서 제외)
  if (/^(ON|IN|AT|TO|FROM|OVER|INSERT|CU|POV|ANGLE|CLOSE|WIDE|BACK|REVERSE|MONTAGE|INTERCUT|SERIES|MEANWHILE|VARIOUS|LATER|CONTINUOUS|MUSIC|CHYRON|SUPER|TITLE|CREDIT|OMITTED|ACROSS|THROUGH|OTHER SIDE)\b/i.test(s)) return false
  if (/\b(STAGE|TV|ROOM|COUNTER|CURTAIN|TURNBUCKLE|HALLWAY|LOBBY|KITCHEN|OFFICE|DESK|DOORWAY|WINDOW|BAR\b)\b/i.test(s) && !/^(MISTER|MISS|MRS|DOCTOR|DR|OFFICER|DETECTIVE)/i.test(s)) return false  // 장소 라벨 (호칭+장소어 인물명은 예외)
  if (/[가-힣]/.test(s) && /(다|요|까|네|군|지|어|아|니|데|음|함)\.?$/.test(s)) return false  // 한국어 문장 종결 = 조각
  return true
}

// 메타/쓰레기 — 블록에서 제거 (양쪽 동일 기준). 진짜 [크레딧:]/[자막:]은 보존.
function isJunk(text) {
  const t = text.trim()
  if (!t) return true
  if (/^```/.test(t)) return true
  if (/^NOTE\s*:/i.test(t)) return true
  if (/(포맷할 수 없습니다|번역할 수 없습니다|번역할 각본 텍스트가 전달되지|실제 각본 원문을 붙여)/.test(t)) return true
  if (/^\[크레딧:\s*['"]?…/.test(t)) return true   // 깨진 크레딧 잔해
  if (/^@?\s*REVISED\b/i.test(t)) return true       // 각본 개정 마커(여백 꼬릿말) — "@REVISED 7/27/87"
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/.test(t)) return true  // 단독 날짜 줄
  return false
}

// EN 대사 블록 안에 "지문(3인칭 서술)"이 빈 줄 없이 끼어든 경우 분리.
// 노래 가사(1·2인칭, 명령형) 뒤에 "He spies...", "Willy grabs..." 같은 지문이 붙는 추출 결함 대응.
function isActionLineEN(s) {
  const t = s.trim()
  if (!t) return false
  if (/\b(I|I'm|I'll|I've|I'd|me|my|mine|we|we're|us|our|you|your|let's)\b/i.test(t)) return false  // 1·2인칭 = 가사
  if (!/^(He|She|It|They|His|Her|Their|The|A|An|Willy|Charlie|Noodle|Mrs|Mr|At|As|From|Then|Suddenly|Finally|Now|Inside|Outside|Meanwhile|Up|Down)\b/.test(t)) return false  // 3인칭 서술 시작
  if (/[.]$/.test(t)) return true                 // 마침표로 끝나는 완결 문장
  if (/\b[A-Z]{2,}\b/.test(t)) return true        // 대문자 고유명사/강조(지문 신호)
  return false
}
// dialogue 블록을 [가사 dialogue, 지문 action]으로 분리(첫 지문줄부터 끝까지 지문). rt=재번역 표시.
function splitTrailingAction(block) {
  if (block.type !== 'dialogue') return [block]
  const lines = block.text.split('\n')
  let a = -1
  for (let i = 0; i < lines.length; i++) { if (isActionLineEN(lines[i])) { a = i; break } }
  if (a <= 0) return [block]   // 분리 없음(또는 블록 전체가 지문 → 그대로 둠)
  const dia = lines.slice(0, a).join('\n').trim()
  const act = lines.slice(a).join('\n').trim()
  const out = []
  if (dia) out.push({ type: 'dialogue', text: dia, rt: true })
  if (act) out.push({ type: 'action', text: act, rt: true })
  return out.length ? out : [block]
}

function parseBlocks(text, splitAction = false) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks = []
  let cur = null            // { type, lines:[] }
  let dialogueMode = false  // character 큐 직후
  const flush = () => { if (cur && cur.lines.length) blocks.push({ type: cur.type, text: cur.lines.join('\n') }); cur = null }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') { flush(); continue }   // 빈 줄 = 경계
    if (isScene(line)) { flush(); blocks.push({ type: 'scene', text: line.trim() }); dialogueMode = false; continue }
    if (isCharacter(line)) {
      if (looksLikeRealCue(line)) { flush(); blocks.push({ type: 'character', text: line.trim() }); dialogueMode = true; continue }
      // 가짜 큐 → @ 떼고 지문(action)으로 강등
      const demoted = line.trim().replace(/^@\s*/, '')
      flush(); cur = { type: 'action', lines: [demoted] }; dialogueMode = false; continue
    }
    if (dialogueMode && isParen(line) && (!cur)) { flush(); blocks.push({ type: 'paren', text: line.trim() }); continue }
    // 연속 줄 누적 (dialogue 모드면 dialogue, 아니면 action)
    const kind = dialogueMode ? 'dialogue' : 'action'
    if (!cur || cur.type !== kind) { flush(); cur = { type: kind, lines: [] } }
    cur.lines.push(line)
  }
  flush()
  let out = blocks.filter(b => !isJunk(b.text))
  if (splitAction) {   // EN: 대사에 끼어든 지문 분리
    const ex = []
    for (const b of out) { if (b.type === 'dialogue') ex.push(...splitTrailingAction(b)); else ex.push(b) }
    out = ex
  }
  return out
}

const ANCHOR = new Set(['scene', 'character', 'paren'])

// 마커(앵커) 시퀀스만 추출 — 타입만 비교(이름 무시, 순서로 짝지음)
function markerSeq(blocks) { return blocks.map((b, i) => ({ ...b, i })).filter(b => ANCHOR.has(b.type)) }

// 타입 기준 LCS — EN·KO 마커를 순서대로 정렬. 반환: [{en:idxOrNull, ko:idxOrNull}]
function lcsAlign(enMarks, koMarks) {
  const n = enMarks.length, m = koMarks.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--)
    dp[a][b] = enMarks[a].type === koMarks[b].type ? dp[a + 1][b + 1] + 1 : Math.max(dp[a + 1][b], dp[a][b + 1])
  const pairs = []
  let a = 0, b = 0
  while (a < n && b < m) {
    if (enMarks[a].type === koMarks[b].type) { pairs.push({ en: a, ko: b }); a++; b++ }
    else if (dp[a + 1][b] >= dp[a][b + 1]) { pairs.push({ en: a, ko: null }); a++ }
    else { pairs.push({ en: null, ko: b }); b++ }
  }
  while (a < n) pairs.push({ en: a++, ko: null })
  while (b < m) pairs.push({ en: null, ko: b++ })
  return pairs
}

// KO filler 배열을 EN 개수 E에 맞춰 재그룹 (블록 경계만 맞추면 됨 — 내부는 공백병합되니 무관)
function regroup(koFillers, E) {
  if (E <= 0) return []
  if (koFillers.length === 0) return new Array(E).fill(null)  // 미번역 갭
  if (E === 1) return [koFillers.map(b => b.text).join(' ')]
  // E개 그룹으로 균등 분배
  const out = []
  const per = koFillers.length / E
  for (let g = 0; g < E; g++) {
    const s = Math.round(g * per), e = Math.round((g + 1) * per)
    const chunk = koFillers.slice(s, Math.max(e, s + 1))
    out.push(chunk.map(b => b.text).join(' '))
  }
  return out
}

// 갭필 번역지침 — 서버 prompts.json에서 로드 (품질용). 실패하면 빈 지침.
let GAP_GUIDE = ''
async function loadGapGuide() {
  if (!GAPFILL) return
  try {
    const res = await fetch(`${SERVER}/api/load-prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    if (res.ok) GAP_GUIDE = (await res.json()).translate || ''
  } catch {}
}
// cue: 대사 블록이면 앞 @인물 큐를 맥락으로 같이 보냄(짧은 단편 echo 방지). 결과에선 큐 줄을 떼고 반환.
async function gapTranslate(enText, cue = null) {
  if (!GAPFILL) return null
  const payload = cue ? `${cue}\n${enText}` : enText
  // 모델이 짧은 단편을 가끔 영어로 echo함 → 한글 없는 결과면 재시도 (최대 3회)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SERVER}/api/translate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formattedText: payload, guidelines: GAP_GUIDE, model: MODEL }),
      })
      if (!res.ok) continue
      let t = ((await res.json()).translated || '').trim()
      if (!t) continue
      if (cue) {   // "@CUE\n번역" → 앞쪽 @큐 줄 제거
        const lines = t.split('\n')
        while (lines.length > 1 && /^@/.test(lines[0].trim())) lines.shift()
        t = lines.join('\n').trim()
      }
      if (/[가-힣]/.test(t) || !/[A-Za-z]{2,}/.test(t)) return t   // 한글 있거나 영어 단어 없으면(기호·외국어 등) 채택
    } catch {}
  }
  return null   // 3번 다 echo면 포기 (영어 유지 — 의도적 외국어일 수 있음)
}

// 미번역 판정: KO 자리가 비었거나(구조 갭) · EN 복제거나 · 한글 없는 영어면 번역 필요.
// 단 전환지시어(CUT TO: 등)는 원래 영어로 두는 게 맞으니 갭으로 안 침 — 호출 낭비 방지.
const hasHangul = (s) => /[가-힣]/.test(s || '')
const isTransition = (s) => /^(CUT TO|FADE (IN|OUT|TO)|DISSOLVE|SMASH CUT|MATCH CUT|JUMP CUT|INTERCUT|REVERSE|BACK TO|TITLE|THE END|OMITTED|CONTINUED)\b/i.test((s || '').trim())
function needsTranslation(en, ko) {
  if (isTransition(en)) return false                                                  // 전환지시어 = 영어 유지
  if (ko == null) return true
  if (ko.trim() === (en || '').trim()) return true                                    // 자리채움/복제
  if (!hasHangul(ko)) {                                                                // KO칸에 한글이 없음 = 미번역 의심
    const words = (ko.match(/[A-Za-z]{2,}/g) || []).length
    if (words >= 2) return true                                                       // 두 단어 이상 영어
    if (/[a-z]/.test(ko)) return true                                                 // 소문자 있는 실제 대사/지문("Sorry.","Louis!") — 대문자 약어/사인(BMW)은 제외
  }
  return false
}

function push(ctx, en, ko, type, rt = false) { ctx.en.push(en); ctx.ko.push(ko); ctx.ty.push(type); ctx.rt.push(rt) }

function nextFillers(blocks, marks, mPos) {
  const start = marks[mPos].i + 1
  const end = mPos + 1 < marks.length ? marks[mPos + 1].i : blocks.length
  return blocks.slice(start, end).filter(b => !ANCHOR.has(b.type))
}

// 마커 사이 filler를 EN 블록 수에 맞춰 재그룹 (KO 부족분은 null = 갭)
function emitSegment(enFillers, koFillers, ctx) {
  const E = enFillers.length
  if (E === 0) {
    if (koFillers.length && ctx.ko.length) {  // EN엔 없는데 KO 잉여 → 직전 블록에 합침
      const extra = koFillers.map(b => b.text).join(' ')
      const last = ctx.ko[ctx.ko.length - 1]
      ctx.ko[ctx.ko.length - 1] = ((last || '') + ' ' + extra).trim()
    }
    return
  }
  const grouped = regroup(koFillers, E)
  if (koFillers.length > E) ctx.st.merges++
  for (let k = 0; k < E; k++) push(ctx, enFillers[k].text, grouped[k], enFillers[k].type, !!enFillers[k].rt)
}

// 한 작품 정렬 → { enOut, koOut, stats }. 1) 결정적 구조 정렬 2) 갭필(구조+내용 갭)
async function alignWork(enText, koText) {
  const en = parseBlocks(enText, GAPFILL), ko = parseBlocks(koText)   // EN만 끼어든 지문 분리(복구=재번역 필요하므로 갭필 시에만)
  const enM = markerSeq(en), koM = markerSeq(ko)
  const pairs = lcsAlign(enM, koM)

  const enOut = [], koOut = [], typeOut = [], rtOut = []
  const st = { merges: 0, gaps: 0, fills: 0, drops: 0, scenes: enM.filter(x => x.type === 'scene').length }
  const ctx = { en: enOut, ko: koOut, ty: typeOut, rt: rtOut, st }

  // 맨 앞(첫 마커 이전) filler
  const enHead = en.slice(0, enM.length ? enM[0].i : en.length).filter(b => !ANCHOR.has(b.type))
  const koHead = ko.slice(0, koM.length ? koM[0].i : ko.length).filter(b => !ANCHOR.has(b.type))
  emitSegment(enHead, koHead, ctx)

  for (const p of pairs) {
    if (p.en != null && p.ko != null) {
      push(ctx, en[enM[p.en].i].text, ko[koM[p.ko].i].text, en[enM[p.en].i].type)
      emitSegment(nextFillers(en, enM, p.en), nextFillers(ko, koM, p.ko), ctx)
    } else if (p.en != null) {
      const enBlk = en[enM[p.en].i]
      push(ctx, enBlk.text, null, enBlk.type)   // KO 마커 없음 → null (갭필서 채움)
      emitSegment(nextFillers(en, enM, p.en), [], ctx)
    } else {
      st.drops++   // EN에 없는 KO 마커 → 환각/중복, 버림
    }
  }

  // 갭필 패스: 구조 갭(null) + 내용 갭(KO가 영어) 둘 다. @인물 큐 이름은 번역 안 함.
  let lastCue = null   // 직전 @인물 큐 (대사 맥락용)
  for (let i = 0; i < koOut.length; i++) {
    if (typeOut[i] === 'character') { koOut[i] = koOut[i] ?? enOut[i]; lastCue = enOut[i]; continue }
    if (rtOut[i]) koOut[i] = null   // 분리된 노래/지문 → 기존(지문 들러붙은) KO 버리고 EN에서 재번역
    if (needsTranslation(enOut[i], koOut[i])) {
      st.gaps++
      const g = await gapTranslate(enOut[i], typeOut[i] === 'dialogue' ? lastCue : null)
      if (g) st.fills++
      koOut[i] = g || koOut[i] || enOut[i]
    } else {
      koOut[i] = koOut[i] ?? enOut[i]
    }
  }
  return { enOut, koOut, st, balanced: enOut.length === koOut.length }
}

// 블록 배열 → scriptroom 친화 txt (블록 사이 빈 줄 1개)
function render(blocks) { return blocks.join('\n\n') + '\n' }

// ── 작품 순회 ────────────────────────────────────────────────────────
function findPair(dir) {
  const files = readdirSync(dir)
  const f = files.find(x => /_formatted\.txt$/.test(x))
  const t = files.find(x => /_translated\.txt$/.test(x))
  return f && t ? { f: join(dir, f), t: join(dir, t) } : null
}

const onlySet = ONLY ? new Set(ONLY.split(',').map(s => s.trim()).filter(Boolean)) : null
const works = readdirSync(CONTENT_DIR)
  .filter(w => !onlySet || onlySet.has(w))
  .map(w => join(CONTENT_DIR, w))
  .filter(p => { try { return statSync(p).isDirectory() } catch { return false } })

console.log(`정렬 대상 검색: ${CONTENT_DIR}  (write=${WRITE} overwrite=${OVERWRITE} gapfill=${GAPFILL})`)
// 갭필 요청 시 서버 가용성 선확인 — 꺼져 있으면 영어 자리채움으로 덮어쓰는 사고 방지
if (GAPFILL) {
  let up = false
  try { up = (await fetch(`${SERVER}/api/health`)).ok } catch {}
  if (!up) { console.error(`✗ 갭필 ON인데 서버(${SERVER})에 연결 안 됨. 앱(서버) 켜고 다시 실행하세요.`); process.exit(1) }
}
await loadGapGuide()
if (GAPFILL) console.log(`갭필 ON · 모델 ${MODEL} · 지침 ${GAP_GUIDE ? '로드됨' : '없음(빈 지침)'}`)
let done = 0
for (const dir of works) {
  const pair = findPair(dir)
  if (!pair) continue
  const name = dir.split('/').pop()
  if (name === 'whiplash') { console.log(`- ${name}: 제외(수작업 예외)`); continue }
  const enText = readFileSync(pair.f, 'utf8'), koText = readFileSync(pair.t, 'utf8')
  const { enOut, koOut, st, balanced } = await alignWork(enText, koText)
  console.log(`- ${name}: 씬 ${st.scenes} · 블록 ${enOut.length} · 병합 ${st.merges} · 갭 ${st.gaps}${GAPFILL ? `(채움 ${st.fills})` : ''} · 드롭 ${st.drops} · 균형 ${balanced ? 'OK' : '⚠불일치'}`)
  if (WRITE && balanced) {
    const enPath = OVERWRITE ? pair.f : pair.f.replace(/\.txt$/, '.aligned.txt')
    const koPath = OVERWRITE ? pair.t : pair.t.replace(/\.txt$/, '.aligned.txt')
    // .bak은 최초 1회만 (재실행 시 진짜 원본 백업을 정렬본으로 덮지 않게)
    if (OVERWRITE) {
      if (!existsSync(pair.f + '.bak')) copyFileSync(pair.f, pair.f + '.bak')
      if (!existsSync(pair.t + '.bak')) copyFileSync(pair.t, pair.t + '.bak')
    }
    writeFileSync(enPath, render(enOut)); writeFileSync(koPath, render(koOut))
  }
  done++
}
console.log(`\n완료: ${done}개 작품 처리`)
