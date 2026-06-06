// Theme tokens
export const T = {
  bg: '#0f0f0f',
  bgCard: '#1a1a1a',
  bgInput: '#111',
  fg: '#f0f0f0',
  fgMuted: '#888',
  fgDim: '#555',
  rule: '#222',
  accent: '#c8a96e',
  accentFg: '#0f0f0f',
  good: '#4caf82',
  warn: '#e09040',
  err: '#e05050',
  chip: '#252525',
}

export const DEFAULT_FORMAT_GUIDELINES = `PDF 텍스트 레이어 추출. 페이지 번호/헤더/푸터/타이틀 페이지 제거. 내용 추가·요약 금지. 원문 언어 그대로, 마커만 추가.

출력 형식:
# INT./EXT. 장소-시간대   씬 헤딩
지문                       일반 텍스트
@인물명                    캐릭터 큐 (V.O./O.S. 포함 시: @MARK (V.O.))
(괄호지문)                 괄호 지시
대사                       일반 텍스트
CUT TO:                    전환 지시어 (마커 없이 그대로)
[CREDIT: 텍스트]           오프닝/클로징 크레딧
[SUPER: 텍스트]            화면 삽입 텍스트 (장소·시간 자막, SUPER: 등)

규칙:
- 씬 헤딩 시작 키워드: INT. / EXT. / INT./EXT. / EXT./INT. / INSERT / INTERCUT / MONTAGE / SERIES OF SHOTS — 반드시 # 으로 시작
- 씬 번호 prefix 제거: "19 EXT. LOCATION" → "# EXT. LOCATION", "SCENE 3 - INT. LOCATION" → "# INT. LOCATION"
- 씬 번호가 헤딩 끝에 반복될 경우 제거: "INT. LOCATION DAY 19" → "# INT. LOCATION - DAY"
- 비표준 씬 헤딩 정규화: "LOCKER ROOM--BILLY AND TEJADA - DAY" → "# INT. LOCKER ROOM - DAY" 처럼 장소 맥락으로 INT./EXT. 추론 후 # 헤딩으로 변환
- EXT/INT. 또는 INT/EXT. (점 생략 형식)도 표준 # 헤딩으로 변환
- 페이지 번호/마커 제거 (Page 40/130, 페이지 단독 숫자 줄 등)
- 전환 지시어(CUT TO: / FADE IN: / FADE OUT: / SMASH CUT TO: 등)는 그대로 텍스트로
- 구조 판단은 각본 문법 기준 (들여쓰기, 대문자 패턴 등)
- 각 씬은 헤딩 포함 완결된 단위로 출력
- 대사 블록 끝나고 지문 이어지면 빈 줄 하나 삽입`

export const DEFAULT_TRANSLATE_GUIDELINES = `동일 구조 유지. @인물명·전환 지시어·마커 형태 그대로. 줄 단위 직역 금지, 장면 단위 맥락 번역. 욕설 질감 살림, 한국어 자연스러운 구어체.

규칙:
- 씬 헤딩 전체 번역: # INT. → # 내부. / # EXT. → # 외부. / # INSERT → # 삽입 등. 장소명·시간대도 한국어로.
- @인물명 절대 번역 금지 (파서 사용) — V.O./O.S./CONT'D 등 수식어도 그대로
- 지문 안 인물명(대문자) 한국어로 (BLAKE → 블레이크, SOLDIERS → 병사들)
- (괄호지문) 번역
- [CREDIT:] → [크레딧:] / [SUPER:] → [자막:] 로 마커 변환, 내용도 번역
- CUT TO: 등 전환 지시어 그대로
- 대사-지문 사이 빈 줄 유지

SMI 참고 시: 대사는 SMI 1순위, 오역 판단 시 독자 판단 우선. 호칭·말투·경어는 SMI 기준.`

// Settings
export const DEFAULT_SETTINGS = {
  concurrency: 3,             // 동시 처리 씬 수
  model: 'claude-haiku-4-5',  // 사용 모델
}

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('convert_settings') || '{}') }
  } catch { return DEFAULT_SETTINGS }
}

export function saveSettings(s) {
  localStorage.setItem('convert_settings', JSON.stringify(s))
}

export function saveGuidelines(type, text) {
  localStorage.setItem(`convert_guidelines_${type}`, text)
}

export function loadGuidelines(type) {
  return localStorage.getItem(`convert_guidelines_${type}`) ||
    (type === 'format' ? DEFAULT_FORMAT_GUIDELINES : DEFAULT_TRANSLATE_GUIDELINES)
}

// SMI 씬별 슬라이스: 전체 줄에서 씬 위치 비율에 맞는 구간만 추출
export function sliceSmi(smiLines, sceneIndex, totalScenes, windowLines = 60) {
  if (!smiLines || smiLines.length === 0) return null
  const center = Math.floor((sceneIndex / totalScenes) * smiLines.length)
  const start = Math.max(0, center - Math.floor(windowLines / 2))
  const end = Math.min(smiLines.length, start + windowLines)
  return smiLines.slice(start, end).join('\n')
}

// History
export function saveHistory(entry) {
  const hist = loadHistory()
  const id = entry.id || Date.now()
  const existing = hist.findIndex(h => h.id === id)
  if (existing >= 0) hist[existing] = { ...hist[existing], ...entry, id }
  else hist.unshift({ ...entry, id })
  try {
    localStorage.setItem('convert_history', JSON.stringify(hist.slice(0, 10)))
  } catch {
    // localStorage 용량 초과 시 씬 데이터 없이 저장
    const light = hist.slice(0, 10).map(h => ({ ...h, scenes: h.sceneCount, sceneData: undefined }))
    localStorage.setItem('convert_history', JSON.stringify(light))
  }
}

export function loadHistory() {
  try { return JSON.parse(localStorage.getItem('convert_history') || '[]') } catch { return [] }
}

export function deleteHistory(id) {
  const hist = loadHistory().filter(h => h.id !== id)
  localStorage.setItem('convert_history', JSON.stringify(hist))
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
