// Theme tokens — scriptroom 바우하우스 결(따뜻한 종이톤 + 3원색), 라이트/다크 분리
// 색 의미: 파랑=포맷/구조(fmt) · 빨강=번역 KO(trans) · 노랑=주의(warn) · 초록=완료(good)
import { APP_VERSION } from './version.js'

// 액센트 = 액션/크롬 색만(버튼·탭·로고). 버전마다 빨→파→노 회전(색=버전 세대), 설정에서 고정 선택 가능.
// ★ 상태 의미가 있는 곳(진행바·완료·오류)에는 절대 쓰지 말 것 — 거긴 good/warn/err/fmt 고정색.
export const ACCENTS = {
  red:    { accent: '#C0392B', accentFg: '#FFFFFF', label: '빨강' },
  blue:   { accent: '#1E4D8C', accentFg: '#FFFFFF', label: '파랑' },
  yellow: { accent: '#D9A400', accentFg: '#1A1A1A', label: '노랑' },
}
const ACCENT_CYCLE = ['red', 'blue', 'yellow']   // minor % 3 → 0.6=빨 0.7=파 0.8=노 0.9=빨…
export function accentForVersion(v = APP_VERSION) {
  const minor = parseInt(String(v).split('.')[1] || '0', 10) || 0
  return ACCENT_CYCLE[minor % 3]
}
const ACCENT_KEY = 'convert_accent'   // 'auto' | 'red' | 'blue' | 'yellow'
export function currentAccentSetting() { try { return localStorage.getItem(ACCENT_KEY) || 'auto' } catch { return 'auto' } }
export function currentAccentKey() { const s = currentAccentSetting(); return s === 'auto' ? accentForVersion() : s }
function resolveAccent() { return ACCENTS[currentAccentKey()] || ACCENTS.blue }

export const THEMES = {
  // 바우하우스 3원색은 scriptroom과 동일한 고정값: 빨강 #C0392B / 파랑 #1E4D8C / 노랑 #D9A400
  light: {
    bg: '#F4F4F3', bgCard: '#FFFFFF', bgInput: '#FFFFFF', bgMuted: '#E7E7E4',
    fg: '#1A1A1A', fgMuted: '#3D3D3D', fgDim: '#888888',
    rule: 'rgba(0,0,0,0.11)',
    accent: '#1E4D8C', accentFg: '#FFFFFF',
    good: '#3F8F61', warn: '#D9A400', err: '#C0392B',
    fmt: '#1E4D8C',
    trans: '#C0392B',
    chip: 'rgba(0,0,0,0.06)',
    name: 'light',
  },
  dark: {   // scriptroom 다크와 동일한 중립 회색 팔레트 (예전 갈색톤 → 정렬)
    bg: '#0F0F0F', bgCard: '#1A1A1A', bgInput: '#1C1C1C', bgMuted: '#161616',
    fg: '#F0F0F0', fgMuted: '#C0C0C0', fgDim: '#666666',
    rule: 'rgba(255,255,255,0.08)',
    accent: '#1E4D8C', accentFg: '#FFFFFF',
    good: '#7AB37A', warn: '#D9A400', err: '#C0392B',
    fmt: '#1E4D8C',    // 포맷/구조 = 파랑 (scriptroom 고정값)
    trans: '#C0392B',  // 번역(KO) = 빨강 (scriptroom 고정값)
    chip: 'rgba(255,255,255,0.06)',
    name: 'dark',
  },
}

// 오류 메시지를 사람이 읽는 한국어 '종류'로 분류 — 화면 곳곳에서 공용
export function classifyError(msg) {
  const m = (msg || '').toLowerCase()
  if (!msg) return { key: 'unknown', label: '알 수 없는 오류', hint: '잠시 후 다시 시도해 보세요' }
  if (/설치되어 있지 않|claude_not_found|claude code.*설치|cli를 찾을/.test(m)) return { key: 'noclaude', label: 'Claude Code가 설치돼 있지 않아요', hint: 'claude.com/claude-code 에서 설치하세요' }
  if (/로그인이? 필요|\bauth\b|not logged|please.*login|unauthorized|invalid api key|credentials/.test(m)) return { key: 'auth', label: 'Claude 로그인이 필요해요', hint: '터미널에서 claude 실행 → 로그인 후 재개하세요' }
  if (/load failed|failed to fetch|networkerror|network error|err_|econnreset|socket hang/.test(m)) return { key: 'network', label: '네트워크가 끊겼어요', hint: '서버가 바빠 요청이 끊긴 것 — 재시도하면 이어서 처리해요' }
  if (/econnrefused|server.*not|서버.*없|fetch.*refused/.test(m)) return { key: 'server', label: '변환 서버에 연결할 수 없어요', hint: '앱(서버)이 켜져 있는지 확인하세요' }
  if (/null byte/.test(m)) return { key: 'nullbyte', label: '자막 인코딩 오류 (널 바이트)', hint: '자막을 다시 올려 변환하면 해결돼요' }
  if (/rate.?limit|usage limit|quota|too many/.test(m)) return { key: 'rate', label: 'Claude 사용량 한도에 걸렸어요', hint: '한도가 풀린 뒤 재개하세요' }
  if (/timeout|timed out|etimedout/.test(m)) return { key: 'timeout', label: '시간이 초과됐어요', hint: '다시 시도하세요' }
  if (/json|parse|unexpected token/.test(m)) return { key: 'parse', label: 'AI 응답을 읽지 못했어요', hint: '해당 씬을 다시 시도하세요' }
  if (/too large|payload|413|maximum/.test(m)) return { key: 'toolarge', label: '내용이 너무 길어요', hint: '씬을 나눠 다시 시도하세요' }
  if (/exit code|spawn|enoent/.test(m)) return { key: 'proc', label: 'Claude 실행에 문제가 생겼어요', hint: '다시 시도하세요' }
  return { key: 'other', label: '처리 중 오류가 났어요', hint: '다시 시도하세요', raw: msg }
}

const THEME_KEY = 'convert_theme'
export function currentTheme() { try { return localStorage.getItem(THEME_KEY) || 'light' } catch { return 'light' } }

// live binding — 테마/액센트 전환 시 재할당하면 `import { T }` 한 모든 컴포넌트에 반영됨(리렌더 시)
const withAccent = (base) => ({ ...base, ...resolveAccent() })   // 베이스 테마에 현재 액센트 덮기
export let T = withAccent(THEMES[currentTheme()] || THEMES.light)
export function applyTheme(name) {
  T = withAccent(THEMES[name] || THEMES.light)
  try { localStorage.setItem(THEME_KEY, name) } catch {}
  try { document.body.style.background = T.bg; document.body.style.color = T.fg } catch {}
  return T
}
// 액센트 선택 저장 후 테마 재적용(T 재할당 → 리렌더 시 전체 반영)
export function applyAccent(key) {
  try { localStorage.setItem(ACCENT_KEY, key) } catch {}
  return applyTheme(currentTheme())
}

export const DEFAULT_FORMAT_GUIDELINES = `PDF 텍스트 추출. 페이지번호/헤더/푸터/타이틀페이지 제거. 내용 추가·요약 금지, 원문 언어 유지, 마커만 추가.

형식: #씬헤딩 / 지문(일반텍스트) / @인물명(큐, V.O./O.S.는 @MARK (V.O.)) / (괄호지문) / - 대사(맨 앞 '- ' 마커) / (CUT TO:)(전환도 괄호로) / [크레딧:…] / [타이틀:…] / [자막:…화면삽입자막]

★특수 표기(자막/타이틀/크레딧/전환)는 전부 자기만의 독립된 한 줄(앞뒤 빈 줄)로 — 절대 다른 문장 안에 인라인 금지.

규칙:
- 헤딩 키워드(INT./EXT./INT./EXT./INSERT/INTERCUT/MONTAGE/SERIES OF SHOTS)는 반드시 #로 시작
- 씬번호 prefix/suffix 제거: "19 EXT. X"→"# EXT. X", "INT. X DAY 19"→"# INT. X - DAY"
- 비표준 헤딩은 장소맥락으로 INT./EXT. 추론해 #로 정규화("LOCKER ROOM--… - DAY"→"# INT. LOCKER ROOM - DAY"), 점생략형(EXT/INT.)도 표준화
- 페이지번호/단독 숫자줄 제거
- 전환지시어(CUT TO:/FADE IN:/FADE OUT:/SMASH CUT TO: 등)는 '(CUT TO:)'처럼 괄호로 감싸 독립된 한 줄로
- 각 씬은 헤딩 포함 완결 단위. 대사 뒤 지문 이어지면 빈 줄 1개 삽입
- ★줄바꿈 정규화(번역본과 줄 맞춤): 한 대사·지문이 PDF 단 너비 때문에 여러 줄로 끊겨 있으면 한 줄(한 문장/문단 단위)로 합친다. 빈 줄은 문단 경계(지문↔대사, 대사↔지문)에만. 문단 중간의 줄바꿈은 남기지 말 것 — 번역본은 문장 단위로 리플로우되므로 포맷도 같은 줄 구조여야 정렬된다`

export const DEFAULT_TRANSLATE_GUIDELINES = `구조·마커 유지(@인물명·전환지시어·대사 앞 '- ' 형태 그대로). 직역 금지, 장면 맥락 번역. 욕설 질감 살린 자연스러운 구어체.

규칙:
- 씬 헤딩 번역: # INT.→내부. EXT.→외부. INSERT/INTERCUT/MONTAGE/SERIES OF SHOTS는 번역하지 말고 인서트/인터컷/몽타주/시리즈 오브 샷처럼 업계에서 쓰는 음차 그대로, 장소·시간대도 한국어
- @인물명 번역 금지(V.O./O.S./CONT'D 수식어 포함 그대로)
- ★대사 줄 맨 앞의 '- ' 는 대사를 표시하는 구조 마커다(#·@처럼). 지우거나 번역하지 말고 그대로 유지
- 지문 속 대문자 인물명 한국어로(BLAKE→블레이크, SOLDIERS→병사들)
- (괄호지문) 번역. [CREDIT:]→[크레딧:], [SUPER:]→[자막:] 내용도 번역
- ★단, [크레딧:] 안의 '작품 제목'(영화 원제 자체)은 번역·음차하지 말고 영어 원문 그대로 둔다.
  화면에 영어 타이틀 카드로 뜨는 것이고, 앱이 한국어 제목을 따로 보여주므로 옮기면 오히려 틀린다
  (There Will Be Blood→'피가 흐를 것이다' 같은 오역 방지). 역할 표기는 한국어로:
  Screenplay by→각본, Story by→원안, Based on the book by→원작. 에피그래프 인용문·스튜디오 표기는 번역
- 전환지시어는 '(CUT TO:)' '(DISSOLVE TO:)'처럼 괄호로 감싼 형태 그대로 유지 — 독립된 한 줄(앞뒤 빈 줄), 문장 중간 인라인 금지. 대사-지문 빈 줄 유지
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

// 번역 구조 검증 — 영문 포맷본과 마커(#·@)·줄 수가 1:1인지. 누락·창작·거부·환각을 한 번에 걸러냄.
// (server.js translationStructureOk와 동일 로직 — 프론트 공용)
export function translationStructureOk(formatted, translated) {
  if (!translated || !translated.trim()) return false
  const heads = (t) => (t.match(/^#/gm) || []).length
  const cues = (t) => (t.match(/^@/gm) || []).length
  const body = (t) => t.split('\n').filter(l => l.trim()).length
  if (heads(formatted) !== heads(translated)) return false
  if (cues(formatted) !== cues(translated)) return false
  const bf = body(formatted), bt = body(translated)
  if (bf > 0 && (bt < bf * 0.6 || bt > bf * 1.6)) return false
  return true
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
