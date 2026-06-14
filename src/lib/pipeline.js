// 포맷·번역 파이프라인의 순수 헬퍼 — 브라우저(App.jsx)와 서버(server.js)가 공유.
// 프레임워크/DOM 의존성 없음. (sliceSmi는 core.js, matchSmiToTranslation은 smi.js)
import { sliceSmi } from './core.js'

export const estTokens = (s) => Math.round((s || '').length / 3)

// 인물 말투 사전용 대사 샘플 — @화자 + 첫 대사 줄을 작품 전반에서 고르게 뽑아 길이 제한
export function buildDialogueSample(scenes, maxChars = 8000) {
  const pairs = []
  for (const sc of scenes || []) {
    const lines = (sc.formatted || sc.raw || '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (!t.startsWith('@')) continue
      const cue = t.replace(/^@/, '').split('(')[0].trim()
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('('))) j++
      const dlg = j < lines.length ? lines[j].trim() : ''
      if (cue && dlg && !dlg.startsWith('@') && !dlg.startsWith('#')) pairs.push(`@${cue}: ${dlg.slice(0, 80)}`)
    }
  }
  if (!pairs.length) return ''
  const cap = 200
  let sampled = pairs
  if (pairs.length > cap) { const step = pairs.length / cap; sampled = Array.from({ length: cap }, (_, k) => pairs[Math.floor(k * step)]) }
  return sampled.join('\n').slice(0, maxChars)
}

// 공식 한국어 자막 샘플 — 말투 글로서리의 '근거'용. 자막 줄을 작품 전반에서 고르게 뽑아 길이 제한.
export function buildSubtitleSample(smiEntries, maxChars = 7000, cap = 160) {
  const lines = (smiEntries || []).filter(l => l && /[가-힣]/.test(l))
  if (!lines.length) return ''
  let sampled = lines
  if (lines.length > cap) { const step = lines.length / cap; sampled = Array.from({ length: cap }, (_, k) => lines[Math.floor(k * step)]) }
  return sampled.join('\n').slice(0, maxChars)
}

// LLM이 본문에 흘리는 "내가 뭘 했다" 메타 코멘트 제거.
// 안전 원칙: ① 키워드가 명확한 줄만 (진짜 본문 [크레딧:]/[자막:]/FADE IN: 등은 보존)
//           ② 텍스트 양 끝에서만 (중간 본문은 절대 안 건드림)
const META_PATTERNS = [
  /^\s*```/,                                                                       // 코드펜스 ```
  /^\s*[(\[][^)\]]*(제거|생략|removed|omitted|no (screenplay|script) content|번역할.*?없|포맷할.*?없|내용\s*없)[^)\]]*[)\]]\s*$/i, // (타이틀 페이지 제거됨) 류
  /^\s*(번역|포맷)\s*(결과|본|텍스트|된\s*각본)?\s*[:：]\s*$/,                        // "번역 결과:" 라벨만
  /^\s*(다음은|아래는|여기(?:에|는)?)\s.*(번역|포맷|각본|결과).*[:：]\s*$/,            // "다음은 번역입니다:"
  /^\s*(here(?:'s| is)|below is)\b.*(translat|format|script).*[:：]?\s*$/i,
  /^\s*(물론입니다|알겠습니다|네[,，]?\s*알겠|좋습니다)[.!]?\s*$/,                     // 인사·수락
  /^\s*(sure|certainly|of course)\b.*$/i,
  /^\s*(translator'?s?\s*note|역자\s*주|옮긴이\s*주|주\s*[:：]|참고\s*[:：])/i,        // 역주/참고
  /^\s*(이상입니다|번역을?\s*(완료|마쳤|마칩니다)|도움이\s*되(?:셨|었))/,             // 꼬리말
  /(포함되지\s*않았|붙여넣어?\s*주시|올려\s*주시|보내\s*주시|번역해\s*드리겠|번역을?\s*시작하겠|제공해\s*주세요|원문\s*텍스트를)/, // 빈 씬 '원문 주세요' 류 거부
]
const isMetaLine = (l) => META_PATTERNS.some(re => re.test(l))
export function stripMeta(text) {
  if (!text) return text
  let lines = text.split('\n')
  const trimEdge = (fromStart) => {
    while (lines.length) {
      const l = fromStart ? lines[0] : lines[lines.length - 1]
      if (l.trim() === '') { fromStart ? lines.shift() : lines.pop(); continue } // 양끝 빈 줄
      if (isMetaLine(l)) { fromStart ? lines.shift() : lines.pop(); continue }    // 메타 줄
      break
    }
  }
  trimEdge(true)
  trimEdge(false)
  return lines.join('\n')
}

// 줄나눔 일관화: 씬마다/배치마다 LLM이 빈 줄을 들쭉날쭉 넣는 문제 → 결정적으로 정리.
// 규칙: 연속 빈 줄은 1개로, # 헤딩·@인물 큐 앞에는 빈 줄 하나 보장, 앞뒤 빈 줄 제거.
export function normalizeSpacing(text) {
  if (!text) return text
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''))
  const out = []
  for (const l of lines) {
    const t = l.trim()
    if (t === '') {
      if (out.length && out[out.length - 1] === '') continue
      out.push(''); continue
    }
    if (/^#/.test(t) || /^@/.test(t)) {
      if (out.length && out[out.length - 1] !== '') out.push('')
    }
    out.push(l)
  }
  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

// LLM 출력 후처리 한 방: 메타 제거 + 줄나눔 정리
export const cleanOutput = (text) => normalizeSpacing(stripMeta(text))

// 자막 컨텍스트: 씬 길이에 비례해 가변 슬라이싱 (짧은 씬은 적게 → 토큰 절감)
export function getSmiContext(smiLines, scene, totalScenes) {
  if (!smiLines) return null
  const lines = scene.raw.split('\n').filter(Boolean).length
  const win = Math.min(120, Math.max(25, Math.round(lines * 1.4)))
  return sliceSmi(smiLines, scene.id, totalScenes, win)
}

// 짧은 씬을 묶어 배치 구성 (배치당 최대 3씬·60줄, 헤딩으로 시작해야 분할 가능)
export function buildBatches(scenes, enabled) {
  if (!enabled) return scenes.map(s => [s])
  const SHORT = 25, MAX_BATCH = 3, MAX_LINES = 60
  const batches = []; let cur = [], curLines = 0
  for (const s of scenes) {
    const lines = (s.formatted || '').split('\n').length
    const short = lines <= SHORT && (s.formatted || '').trimStart().startsWith('#')
    if (short && cur.length < MAX_BATCH && curLines + lines <= MAX_LINES) {
      cur.push(s); curLines += lines
    } else {
      if (cur.length) { batches.push(cur); cur = []; curLines = 0 }
      if (short) { cur = [s]; curLines = lines } else batches.push([s])
    }
  }
  if (cur.length) batches.push(cur)
  return batches
}

// 번역본을 # 헤딩 기준으로 분할 (배치 응답 쪼개기)
export function splitByHeading(text) {
  const parts = []; let cur = []
  for (const l of text.split('\n')) {
    if (/^#\s/.test(l) && cur.length) { parts.push(cur.join('\n')); cur = [] }
    cur.push(l)
  }
  if (cur.length) parts.push(cur.join('\n').replace(/\n+$/, ''))
  return parts.map(p => p.replace(/\n+$/, ''))
}
