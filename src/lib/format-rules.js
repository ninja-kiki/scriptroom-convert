// 규칙 기반 포매터 — LLM 없이 패턴으로 # @ 마커 부여.
// 확신 낮으면 호출측이 LLM 포맷으로 폴백.

// 진짜 씬 헤딩(키워드 명시)만. ※ "짧은 대문자 줄"은 인물 큐일 수 있으니 헤딩으로 보지 않음.
// INT./EXT. 없는 "장소 - 시간대" 슬러그라인도 헤딩으로 인정 (라따뚜이식). 시간대로 끝나는
// 대문자 줄만 → 인물 큐("DARBY")나 대문자 지문은 안 걸림 ( " - 시간" 패턴이 핵심 ).
function isSluglineHeading(t) {
  const s = (t || '').trim()
  if (s.length < 5 || s.length > 70 || !/\s[-–—]\s/.test(s)) return false
  const letters = s.replace(/[^A-Za-z]/g, ''), upper = s.replace(/[^A-Z]/g, '')
  if (letters.length < 3 || upper.length / letters.length < 0.85) return false
  return new RegExp(`\\b(${TIME_WORD})\\b`, 'i').test(s.split(/\s[-–—]\s/).pop())
}
function isStrictHeading(t) {
  return (
    /(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(t) ||
    /^([A-Z]{0,2}\d+\.?\s+)?(SCENE\s+\d+|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)\b/i.test(t) ||
    isSluglineHeading(t)
  )
}

// 헤딩 정규화: 앞뒤 씬번호 제거, # 부여
const TIME_WORD = 'DAY|NIGHT|MORNING|EVENING|AFTERNOON|DUSK|DAWN|NOON|MIDNIGHT|CONTINUOUS|LATER|EARLIER|MOMENTS|SAME|MAGIC HOUR|SUNSET|SUNRISE'
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
  // 가짜 큐 배제: 문장부호 끝(지문·외침), 관사-묘사, 5단어+(묘사), 카메라/장소 라벨
  if (/[.,!?;]$/.test(core)) return false
  if (/^(A|AN)\s/i.test(core)) return false   // "A MAN'S VOICE" 류
  if (core.split(/\s+/).length > 4) return false
  if (/^(ON|IN|AT|TO|FROM|OVER|INSERT|CU|POV|ANGLE|CLOSE|WIDE|BACK|REVERSE|MONTAGE|INTERCUT|SERIES|MEANWHILE|VARIOUS|LATER|CONTINUOUS|MUSIC|CHYRON|SUPER|CREDIT|ACROSS|THROUGH|OTHER SIDE)\b/i.test(core)) return false
  if (/\b(STAGE|TV|ROOM|COUNTER|CURTAIN|TURNBUCKLE|HALLWAY|LOBBY)\b/i.test(core) && !/^(MISTER|MISS|MRS|DOCTOR|DR|OFFICER|DETECTIVE)/i.test(core)) return false
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
// PDF 단 너비로 한 문장이 여러 줄로 끊긴 걸 한 줄로 합침(리플로우).
// 본문(지문/대사)에서 '앞 줄이 종결부호 없이 끝 + 다음 줄도 본문'이면 이어붙임.
// 마커(#·@·괄호·대사'- ')·종결부호·빈 줄·목록은 경계로 보고 합치지 않음.
export function reflowBody(lines) {
  const res = []
  for (const line of lines) {
    const t = line.trim()
    const prev = res.length ? res[res.length - 1] : null
    const prevT = prev != null ? prev.trim() : ''
    const bodyPrev = prevT && !/^[#@(-]/.test(prevT)
    const bodyCur = t && !/^[#@(-]/.test(t)
    const prevOpen = !/[.!?…:;"'’”)\]]$/.test(prevT)   // 앞 줄이 종결부호 없이 끝남(=문장 미완)
    const curContinues = !/^[-•*]/.test(t)             // 다음 줄이 목록 표시로 시작하지 않음
    if (bodyPrev && bodyCur && prevOpen && curContinues) {
      res[res.length - 1] = prev.replace(/\s+$/, '') + ' ' + t
    } else {
      res.push(line)
    }
  }
  return res
}

export function ruleFormat(raw) {
  const cleaned = raw.split('\n').filter(l => {
    const t = l.trim()
    if (/^Page\s+\d+/i.test(t)) return false
    if (/^\d{1,4}\.?$/.test(t)) return false // 단독 페이지번호
    return true
  })

  // 들여쓰기 밴드 감지 — 추출이 x좌표를 앞 공백으로 보존해줌(각본은 왼쪽여백=지문, 들여쓰기=대사).
  // 지문 깊이 = 비어있지 않은 줄의 최빈 들여쓰기. 대사 = 그보다 4칸+ 깊은 줄.
  const indentOf = (l) => (l.match(/^ */) || [''])[0].length
  const freq = new Map()
  for (const l of cleaned) { if (l.trim()) { const d = indentOf(l); freq.set(d, (freq.get(d) || 0) + 1) } }
  const actionDepth = [...freq].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  const hasIndent = [...freq.keys()].some(d => d >= actionDepth + 4)   // 들여쓰기 정보가 실재할 때만 사용
  const isDialogueDepth = (l) => hasIndent && indentOf(l) >= actionDepth + 4

  const out = []
  let headings = 0, cues = 0, bodyLines = 0
  let firstContentSeen = false, firstIsHeading = false
  let prevBodyWasDialogue = false

  for (const line of cleaned) {
    const t = line.trim()
    if (!t) { out.push(''); prevBodyWasDialogue = false; continue }
    const heading = isStrictHeading(t)
    if (!firstContentSeen) { firstContentSeen = true; firstIsHeading = heading }
    if (heading) { out.push(normalizeHeading(t)); headings++; prevBodyWasDialogue = false; continue }
    if (isCharCue(t)) { out.push(toCue(t)); cues++; prevBodyWasDialogue = true; continue }   // 큐 다음은 대사 맥락
    // 대사 들여쓰기 → 지문(왼쪽) 복귀 지점에 빈 줄 — 대사·지문이 붙는 근본 원인 차단
    const dlg = isDialogueDepth(line)
    if (prevBodyWasDialogue && !dlg && out.length && out[out.length - 1].trim() !== '') out.push('')
    out.push(t); bodyLines++ // 지문/대사 — 마커 없음 (출력은 평평하게)
    prevBodyWasDialogue = dlg
  }

  // 확신도
  let confidence = 1
  if (headings === 0) confidence -= 0.5             // 씬 헤딩 못 찾음
  if (firstContentSeen && !firstIsHeading) confidence -= 0.4 // 첫 줄이 헤딩 아님(비표준 헤딩 추론 필요)
  if (bodyLines > 8 && cues === 0) confidence -= 0.4 // 본문 많은데 인물 큐 0 = 의심
  confidence = Math.max(0, confidence)

  return { formatted: reflowBody(out).join('\n'), confidence, stats: { headings, cues, bodyLines } }
}
