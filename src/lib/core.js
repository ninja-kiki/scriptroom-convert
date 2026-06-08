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

export const DEFAULT_FORMAT_GUIDELINES = `PDF 텍스트 추출. 페이지번호/헤더/푸터/타이틀페이지 제거. 내용 추가·요약 금지, 원문 언어 유지, 마커만 추가.

형식: #씬헤딩 / 지문(일반텍스트) / @인물명(큐, V.O./O.S.는 @MARK (V.O.)) / (괄호지문) / 대사(일반텍스트) / CUT TO:(마커없이) / [CREDIT:…] / [SUPER:…화면삽입자막]

규칙:
- 헤딩 키워드(INT./EXT./INT./EXT./INSERT/INTERCUT/MONTAGE/SERIES OF SHOTS)는 반드시 #로 시작
- 씬번호 prefix/suffix 제거: "19 EXT. X"→"# EXT. X", "INT. X DAY 19"→"# INT. X - DAY"
- 비표준 헤딩은 장소맥락으로 INT./EXT. 추론해 #로 정규화("LOCKER ROOM--… - DAY"→"# INT. LOCKER ROOM - DAY"), 점생략형(EXT/INT.)도 표준화
- 페이지번호/단독 숫자줄 제거
- 전환지시어(CUT TO:/FADE IN:/FADE OUT:/SMASH CUT TO: 등) 그대로
- 각 씬은 헤딩 포함 완결 단위. 대사 뒤 지문 이어지면 빈 줄 1개 삽입`

export const DEFAULT_TRANSLATE_GUIDELINES = `구조·마커 유지(@인물명·전환지시어 형태 그대로). 직역 금지, 장면 맥락 번역. 욕설 질감 살린 자연스러운 구어체.

규칙:
- 씬 헤딩 번역: # INT.→내부. EXT.→외부. INSERT→삽입 등, 장소·시간대도 한국어
- @인물명 번역 금지(V.O./O.S./CONT'D 수식어 포함 그대로)
- 지문 속 대문자 인물명 한국어로(BLAKE→블레이크, SOLDIERS→병사들)
- (괄호지문) 번역. [CREDIT:]→[크레딧:], [SUPER:]→[자막:] 내용도 번역
- CUT TO: 등 전환지시어 그대로. 대사-지문 빈 줄 유지
- SMI 있으면 대사는 SMI 1순위(호칭·말투·경어 기준), 명백한 오역만 교정`

// Settings
export const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku (빠름·쌈)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet (균형)' },
  { id: 'claude-opus-4-8', label: 'Opus (고품질)' },
]
export const DEFAULT_SETTINGS = {
  concurrency: 3,                    // 동시 처리 씬 수
  model: 'claude-haiku-4-5',         // (구) 공통 모델 — 폴백용
  formatModel: 'claude-haiku-4-5',   // 구조/포맷 LLM 폴백 (싸게)
  translateModel: 'claude-sonnet-4-6',// 번역 (기본 Sonnet — 품질)
  batchShort: true,                  // 짧은 씬 배칭으로 호출수 절감
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
  // repo 파일(prompts.json)에도 저장 → 커밋하면 동료에게 공유됨 (실패해도 무시)
  fetch('/api/save-prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [type]: text }),
  }).catch(() => {})
}

export function loadGuidelines(type) {
  return localStorage.getItem(`convert_guidelines_${type}`) ||
    (type === 'format' ? DEFAULT_FORMAT_GUIDELINES : DEFAULT_TRANSLATE_GUIDELINES)
}

// 처리 진단 로그 — 어떻게 읽고 처리했는지 repo 파일(process-log.jsonl)에 누적
// (오류 원인 추적·학습용. 실패해도 무시)
export function logProcess(entry) {
  fetch('/api/log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...entry, ts: new Date().toISOString() }),
  }).catch(() => {})
}

// 영화별 인물 글로서리(메모) 로드/저장 — repo 파일 공유
export async function loadGlossary(title) {
  if (!title) return ''
  try {
    const res = await fetch('/api/load-glossary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    if (!res.ok) return ''
    const all = await res.json()
    return all[title] || ''
  } catch { return '' }
}
export function saveGlossary(title, memo) {
  if (!title) return
  fetch('/api/save-glossary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, memo }) }).catch(() => {})
}

// 앱 시작 시 repo 파일의 지침을 localStorage로 시드 (동료가 클론하면 그대로 적용)
export async function loadPromptsFromFile() {
  try {
    const res = await fetch('/api/load-prompts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    if (!res.ok) return
    const p = await res.json()
    if (p.format) localStorage.setItem('convert_guidelines_format', p.format)
    if (p.translate) localStorage.setItem('convert_guidelines_translate', p.translate)
  } catch {}
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
  const done = (entry.sceneData || []).filter(s => s.status === 'done').length
  const total = entry.sceneCount ?? (entry.sceneData || []).length
  const complete = total > 0 && done >= total
  const doneOf = e => e.doneCount ?? (e.sceneData || []).filter(s => s.status === 'done').length

  // 새 기록: 완료본은 무거운 sceneData 버림(이어보기 불필요), 미완은 보존
  let record = {
    id, title: entry.title,
    startTime: entry.startTime, duration: entry.duration,
    sceneCount: total, doneCount: done,
    sceneData: complete ? undefined : entry.sceneData,
  }

  // 같은 작품(같은 id 또는 같은 title)은 한 항목으로 병합 — 중복 방지
  const idx = hist.findIndex(h => h.id === id || (entry.title && h.title === entry.title))
  if (idx >= 0) {
    const prev = hist[idx]
    // 기존이 더 진행됐으면 기존 내용 유지(후퇴 방지), 날짜/시간만 최신으로
    if (doneOf(prev) > done) {
      record = { ...prev, id, startTime: entry.startTime ?? prev.startTime, duration: entry.duration ?? prev.duration }
    }
    hist.splice(idx, 1)
  }
  hist.unshift(record)

  const trimmed = hist.slice(0, 50)
  try {
    localStorage.setItem('convert_history', JSON.stringify(trimmed))
  } catch {
    // 용량 초과: 가장 최근 미완(이어보기) 1건만 sceneData 유지, 나머지는 메타만
    let kept = false
    const light = trimmed.map(h => {
      if (h.sceneData && !kept) { kept = true; return h }
      return { ...h, sceneData: undefined }
    })
    try { localStorage.setItem('convert_history', JSON.stringify(light)) }
    catch { localStorage.setItem('convert_history', JSON.stringify(light.map(h => ({ ...h, sceneData: undefined })))) }
  }
}

export function loadHistory() {
  let hist
  try { hist = JSON.parse(localStorage.getItem('convert_history') || '[]') } catch { return [] }
  // 같은 작품 중복 정리: 작품당 가장 진행된 1건만 (기존에 쌓인 중복도 즉시 제거)
  const byKey = new Map()
  for (const h of hist) {
    const key = h.title || h.id
    const done = h.doneCount ?? (h.sceneData || []).filter(s => s.status === 'done').length
    const cur = byKey.get(key)
    if (!cur || done > cur._done) byKey.set(key, { ...h, _done: done })
  }
  return [...byKey.values()].map(({ _done, ...h }) => h)
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
