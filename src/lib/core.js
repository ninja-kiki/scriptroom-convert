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

export const DEFAULT_FORMAT_GUIDELINES = `PDF 텍스트 레이어 추출. 페이지 번호/헤더/푸터/타이틀 페이지 제거.
내용 추가·요약 금지. 원문 언어 그대로, 마커만 추가.

출력 형식:
# INT./EXT. 장소-시간대   (씬 헤딩)
지문 (일반 텍스트)
@인물명                   (캐릭터 큐)
(괄호지문)                (괄호 지시)
대사 (일반 텍스트)
CUT TO:                   (전환 지시어, 별도 마커 없음)
[크레딧: 텍스트]          (크레딧)
[자막: 텍스트]            (자막)

규칙:
- 씬 헤딩은 # INT. 또는 # EXT. 로만 시작 (# INT./EXT. 포함)
- 전환 지시어(CUT TO: FADE IN: 등)는 그대로 텍스트로
- 구조 판단은 각본 문법 기준 (들여쓰기, 대문자 패턴 등)
- 각 씬은 헤딩 포함 완결된 단위로 출력`

export const DEFAULT_TRANSLATE_GUIDELINES = `동일 구조 유지. 마커/전환 지시어 그대로. 인물명(@ 뒤) 영어 유지.
줄 단위 직역 금지. 장면 단위 맥락 기준으로 번역.
욕설 질감 살림. 완곡 불필요. 한국어 자연스러운 구어체.

규칙:
- # INT./EXT. 씬 헤딩은 번역하지 않고 그대로
- @인물명 그대로 (영어 유지)
- (괄호지문) 번역
- [크레딧:], [자막:] 마커 유지, 내용은 번역
- CUT TO: 등 전환 지시어 그대로

SMI 자막 참고 시:
- 대사 번역은 SMI를 1순위 참고하되, 오역으로 판단되면 독자 판단 우선
- 호칭/말투/경어는 SMI 기준을 따를 것`

// Settings
export const DEFAULT_SETTINGS = {
  concurrency: 2,             // 동시 처리 씬 수
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
  hist.unshift({ ...entry, id: Date.now() })
  localStorage.setItem('convert_history', JSON.stringify(hist.slice(0, 20)))
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
