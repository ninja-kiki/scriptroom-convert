// 규칙 기반 포매터 — LLM 없이 패턴으로 # @ 마커 부여.
// 확신 낮으면 호출측이 LLM 포맷으로 폴백.

// 진짜 씬 헤딩(키워드 명시)만. ※ "짧은 대문자 줄"은 인물 큐일 수 있으니 헤딩으로 보지 않음.
function isStrictHeading(t) {
  return (
    /(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(t) ||
    /^([A-Z]{0,2}\d+\.?\s+)?(SCENE\s+\d+|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)\b/i.test(t)
  )
}

// 헤딩 정규화: 앞뒤 씬번호 제거, # 부여
const TIME_WORD = 'DAY|NIGHT|MORNING|EVENING|AFTERNOON|DUSK|DAWN|NOON|MIDNIGHT|CONTINUOUS|LATER|MOMENTS LATER|SAME|MAGIC HOUR|SUNSET|SUNRISE'
function normalizeHeading(t) {
  let h = t.replace(/^[A-Z]{0,2}\d+\.?\s+/, '').replace(/\s+[A-Z]{0,2}\d+\.?$/, '').trim()
  // 시간대에 씬번호가 붙은 경우 제거: "DAY1" / "MORNING2" / "NIGHT 14" → 키워드만
  h = h.replace(new RegExp(`\\b(${TIME_WORD})\\s*\\d{1,4}\\s*$`, 'i'), '$1')
  return '# ' + h.trim()
}

// 인물 큐인가 — 짧은 대문자 줄(헤딩·전환 아님)
function isCharCue(line) {
  const t = (line || '').trim()
  if (!t) return false
  const core = t.replace(/\s*\([^)]*\)\s*$/, '').replace(/[:：]\s*$/, '').trim()
  if (core.length < 2 || core.length > 28) return false
  if (isStrictHeading(t)) return false
  if (/^(CUT|FADE|DISSOLVE|SMASH|MATCH|TITLE|OMITTED)\b/i.test(core)) return false
  const letters = core.replace(/[^A-Za-z]/g, '')
  if (letters.length < 2) return false
  const upper = core.replace(/[^A-Z]/g, '')
  return upper.length / letters.length >= 0.9 // 거의 전부 대문자
}

// 인물 큐 → @표기 (끝 콜론만 제거, (V.O.) 유지)
function toCue(line) {
  return '@' + line.trim().replace(/[:：]\s*$/, '').trim()
}

// 씬 raw → { formatted, confidence(0~1), stats }. confidence 낮으면 LLM 권장.
export function ruleFormat(raw) {
  const cleaned = raw.split('\n').filter(l => {
    const t = l.trim()
    if (/^Page\s+\d+/i.test(t)) return false
    if (/^\d{1,4}\.?$/.test(t)) return false // 단독 페이지번호
    return true
  })

  const out = []
  let headings = 0, cues = 0, bodyLines = 0
  let firstContentSeen = false, firstIsHeading = false

  for (const line of cleaned) {
    const t = line.trim()
    if (!t) { out.push(''); continue }
    const heading = isStrictHeading(t)
    if (!firstContentSeen) { firstContentSeen = true; firstIsHeading = heading }
    if (heading) { out.push(normalizeHeading(t)); headings++; continue }
    if (isCharCue(t)) { out.push(toCue(t)); cues++; continue }
    out.push(line); bodyLines++ // 지문/대사 — 마커 없음
  }

  // 확신도
  let confidence = 1
  if (headings === 0) confidence -= 0.5             // 씬 헤딩 못 찾음
  if (firstContentSeen && !firstIsHeading) confidence -= 0.4 // 첫 줄이 헤딩 아님(비표준 헤딩 추론 필요)
  if (bodyLines > 8 && cues === 0) confidence -= 0.4 // 본문 많은데 인물 큐 0 = 의심
  confidence = Math.max(0, confidence)

  return { formatted: out.join('\n'), confidence, stats: { headings, cues, bodyLines } }
}
