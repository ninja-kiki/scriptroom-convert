import { useState, useCallback, useRef, useEffect } from 'react'
import { T, applyTheme, currentTheme, applyAccent, currentAccentSetting, loadGuidelines, saveHistory, loadSettings, loadPromptsFromFile, logProcess, translationStructureOk } from './lib/core.js'
import { extractText, ocrPdfViaServer, splitIntoScenes, splitByHeadingIndices, parseSMI, isLikelyHeading, forceSplitScenes } from './lib/pdf.js'
import { ruleFormat } from './lib/format-rules.js'
import { splitGluedAction } from './lib/lint.js'
import { analyzeScenes } from './lib/analyze.js'
import { parseSMIEntries, alignSmi, decodeSubtitle, parseSubtitleLines, subtitleInfo } from './lib/smi.js'
import { detectFileType } from './lib/revise.js'
import UploadStep from './components/UploadStep.jsx'
import ReviewStep from './components/ReviewStep.jsx'
import ProcessPanel from './components/ProcessPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import ReaderMode from './components/ReaderMode.jsx'

const SESSION_KEY = 'convert_session'
function saveSession(data) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)) } catch {} }
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null } }
function clearSession() { localStorage.removeItem(SESSION_KEY) }
// 토큰 추정 (서버가 실제 수치를 안 줘서 길이 기반 근사 — 한/영 혼합 ~3자/토큰)
const estTokens = (s) => Math.round((s || '').length / 3)

// 인물 말투 사전용 대사 샘플 — @화자 + 첫 대사 줄을 작품 전반에서 고르게 뽑아 길이 제한
function buildDialogueSample(scenes, maxChars = 4000) {
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
  const cap = 120
  let sampled = pairs
  if (pairs.length > cap) { const step = pairs.length / cap; sampled = Array.from({ length: cap }, (_, k) => pairs[Math.floor(k * step)]) }
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
function stripMeta(text) {
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
function normalizeSpacing(text) {
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
const cleanOutput = (text) => normalizeSpacing(stripMeta(text))

export default function App() {
  const session = loadSession()
  // 새로고침 시 항상 홈(업로드)으로 — 진행 중이던 작업은 홈의 '이어보기' 카드로 복귀 가능
  // (어차피 새로고침하면 브라우저가 진행 루프를 멈추므로, 멈춘 화면을 보여주기보다 홈+이어보기가 정직함)
  const [step, setStep] = useState('upload') // upload | extracting | review | processing | done | revising
  const [title, setTitle] = useState(session?.title || '')
  const [scenes, setScenes] = useState(session?.scenes || [])
  const [reviewScenes, setReviewScenes] = useState([]) // 검토용 씬 (raw만, API 전)
  const [reviewSmiFile, setReviewSmiFile] = useState(null)
  const [pdfWarnings, setPdfWarnings] = useState([])
  const [phase, setPhase] = useState(session ? 'done' : '')
  const [startTime, setStartTime] = useState(session?.startTime || null)
  const [timeInfo, setTimeInfo] = useState({ activeMs: 0, runningSince: null })  // 실제 처리 시간(방치 제외)
  const [showSettings, setShowSettings] = useState(false)
  const [extractProgress, setExtractProgress] = useState({ cur: 0, total: 0, label: '' })
  const smiLinesRef = useRef(session?.smiLines || null)
  const smiEntriesRef = useRef(null)
  const [smiWarning, setSmiWarning] = useState(null)
  const [smiInfo, setSmiInfo] = useState(null)  // { lang:'ko'|'en', count } 불러온 자막 정보
  const [processInfo, setProcessInfo] = useState(null)  // 씬 감지 진단(방식·오탐 등)
  const [extractElapsed, setExtractElapsed] = useState(0)  // 분석중 경과초

  // 시작 시 repo 지침 파일을 localStorage로 시드 (동료 클론 시 공유 적용)
  useEffect(() => { loadPromptsFromFile() }, [])

  // Claude Code 설치 여부 헬스체크 — 없으면 상단 배너로 안내 (콜리그 온보딩)
  const [claudeMissing, setClaudeMissing] = useState(false)
  useEffect(() => {
    fetch('/api/health').then(r => r.ok ? r.json() : null).then(h => { if (h && h.claude === false) setClaudeMissing(true) }).catch(() => {})
  }, [])

  // 테마(라이트/다크) — live binding T 재할당 + 리렌더
  const [themeName, setThemeName] = useState(currentTheme())
  useEffect(() => { applyTheme(themeName) }, [])  // 마운트 시 body 배경 동기화
  const toggleTheme = useCallback(() => {
    setThemeName(prev => { const n = prev === 'dark' ? 'light' : 'dark'; applyTheme(n); return n })
  }, [])
  const [accentKey, setAccentKey] = useState(currentAccentSetting())
  const changeAccent = useCallback((key) => { applyAccent(key); setAccentKey(key) }, [])
  const navBtn = { padding: '6px 12px', borderRadius: 3, background: T.chip, border: 'none', color: T.fgMuted, fontSize: 13, cursor: 'pointer' }

  // 추출/분석 단계 경과 시간 타이머
  useEffect(() => {
    if (step !== 'extracting') return
    setExtractElapsed(0)
    const t = setInterval(() => setExtractElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [step])
  const scenesRef = useRef(session?.scenes || [])
  const jobIdRef = useRef(session?.jobId || null)
  const isProcessing = useRef(false)
  const isPausedRef = useRef(false)
  const isStoppedRef = useRef(false)
  const characterMemoRef = useRef('')  // 이번 작업의 인물 글로서리 (재처리에서도 동일 사용)
  const [characterMemo, setCharacterMemo] = useState('')  // 표시·편집용 (폴링으로 갱신)
  const [profile, setProfile] = useState(null)  // 작품 진단 결과 (프로파일 칩 표시용)
  const diagRef = useRef(null)  // 이번 작업의 처리 진단 (완료 시/수동 리포트 시 기록)
  const serverJobRef = useRef(null)  // 서버 잡 id (서버가 루프 소유 → 탭 닫아도 계속)
  const pollRef = useRef(null)       // 진행 폴링 인터벌
  const [isPaused, setIsPaused] = useState(false)
  const [isRateLimited, setIsRateLimited] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerStartIdx, setReaderStartIdx] = useState(0)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportNote, setReportNote] = useState('')
  const [reportSaved, setReportSaved] = useState(false)

  const updateScene = useCallback((id, patch) => {
    setScenes(prev => {
      const next = prev.map(s => s.id === id ? { ...s, ...patch } : s)
      scenesRef.current = next
      saveSession({ title, scenes: next, startTime, smiLines: smiLinesRef.current, jobId: jobIdRef.current })
      return next
    })
  }, [title, startTime])

  useEffect(() => {
    function handleBeforeUnload(e) {
      // 서버 잡은 탭 닫아도 계속 도므로 경고 불필요. 브라우저 루프(수정 등)만 경고.
      if (isProcessing.current && !serverJobRef.current) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // API 호출 + 자동 재시도(지수 백오프). RATE_LIMIT은 재시도 안 하고 즉시 throw.
  async function postJSON(url, payload, retries = 2) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        if (res.ok) return await res.json()
        const body = await res.json().catch(() => ({}))
        if (body.code === 'RATE_LIMIT') { const e = new Error(body.error || 'RATE_LIMIT'); e.code = 'RATE_LIMIT'; throw e }
        lastErr = new Error(body.error || `HTTP ${res.status}`)
      } catch (e) {
        if (e.code === 'RATE_LIMIT') throw e
        lastErr = e
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)))
    }
    throw lastErr
  }

  async function processFormat(scene, guidelines) {
    updateScene(scene.id, { status: 'formatting' })
    // 규칙 우선 — 깔끔한 씬은 LLM 없이(0토큰). 확신 낮으면 LLM 폴백.
    const rf = ruleFormat(scene.raw)
    if (rf.confidence >= 0.7) {
      // ★ 영어 포맷본에 대사↔지문 빈 줄 분리 적용 — 번역이 1:1로 따라오게 (서버와 동일)
      const ruleFmt = splitGluedAction(rf.formatted)
      const heading = ruleFmt.split('\n')[0].trim()
      updateScene(scene.id, {
        status: 'formatted', formatted: ruleFmt, formatMethod: 'rule',
        heading: heading.startsWith('#') ? heading : null,
        tokens: { format_in: 0, format_out: 0 },
      })
      return true
    }
    try {
      const fs = loadSettings()
      const res = await postJSON('/api/format', {
        sceneText: scene.raw, guidelines, sceneIndex: scene.id,
        totalScenes: scenesRef.current.length, model: fs.formatModel || fs.model,
      })
      const tokens = res.tokens
      const formatted = splitGluedAction(cleanOutput(res.formatted))  // ★ 대사↔지문 분리 (영어=기준)
      const heading = formatted.split('\n')[0].trim()
      updateScene(scene.id, {
        status: 'formatted', formatted, formatMethod: 'llm',
        heading: heading.startsWith('#') ? heading : null,
        tokens: { format_in: estTokens(scene.raw), format_out: estTokens(formatted) },
      })
      return true
    } catch (e) {
      if (e.code === 'RATE_LIMIT') { setIsRateLimited(true); isPausedRef.current = true; setIsPaused(true) }
      updateScene(scene.id, { status: 'error_format', error: e.message })
      return false
    }
  }

  async function processTranslate(scene, guidelines, characterMemo) {
    updateScene(scene.id, { status: 'translating' })
    try {
      // 직전 씬 끝부분 — 대명사·상황 맥락 (처리 순서 무관하게 raw 사용)
      const idx = scenesRef.current.findIndex(s => s.id === scene.id)
      const prev = idx > 0 ? scenesRef.current[idx - 1] : null
      const prevTail = prev ? prev.raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
      // ★ 구조 가드: 안 맞으면 에러 표시만 (자동 재번역 안 함 — 토큰 절약)
      // 자막은 번역에 직접 안 들어감 — 작품 1회 말투·관계 가이드(characterMemo)로만 반영.
      const _tr = await postJSON('/api/translate', {
        formattedText: scene.formatted, prevTail,
        characterMemo: characterMemo || null, guidelines,
        sceneIndex: scene.id, totalScenes: scenesRef.current.length,
        model: loadSettings().translateModel || loadSettings().model,
      })
      const rawTranslated = cleanOutput(_tr.translated)
      // 자막 교체 안 함 — 정렬 메타(검토용 노랑 표시)만 계산
      const smiMatches = smiEntriesRef.current ? alignSmi(rawTranslated, smiEntriesRef.current).matches : []
      if (!translationStructureOk(scene.formatted, rawTranslated)) {
        updateScene(scene.id, { status: 'error_translate', error: '구조 불일치: 영문 포맷과 줄·마커 수가 안 맞음 (누락/창작/거부 의심) — 재처리 필요' })
        return false
      }
      updateScene(scene.id, {
        status: 'done', translated: rawTranslated, smiMatches,
        tokens: { ...scene.tokens, translate_in: estTokens(scene.formatted), translate_out: estTokens(rawTranslated) },
      })
      return true
    } catch (e) {
      if (e.code === 'RATE_LIMIT') { setIsRateLimited(true); isPausedRef.current = true; setIsPaused(true) }
      updateScene(scene.id, { status: 'error_translate', error: e.message })
      return false
    }
  }

  // 짧은 씬을 묶어 배치 구성 (②와 충돌 줄이려 배치당 최대 3씬·60줄)
  function buildBatches(scenes, enabled) {
    if (!enabled) return scenes.map(s => [s])
    const SHORT = 25, MAX_BATCH = 3, MAX_LINES = 60
    const batches = []; let cur = [], curLines = 0
    for (const s of scenes) {
      const lines = (s.formatted || '').split('\n').length
      const short = lines <= SHORT && (s.formatted || '').trimStart().startsWith('#') // 헤딩으로 시작해야 분할 가능
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
  function splitByHeading(text) {
    const parts = []; let cur = []
    for (const l of text.split('\n')) {
      if (/^#\s/.test(l) && cur.length) { parts.push(cur.join('\n')); cur = [] }
      cur.push(l)
    }
    if (cur.length) parts.push(cur.join('\n').replace(/\n+$/, ''))
    return parts.map(p => p.replace(/\n+$/, ''))
  }

  async function processTranslateBatch(batch, guidelines, characterMemo) {
    batch.forEach(s => updateScene(s.id, { status: 'translating' }))
    const fallback = async () => { for (const s of batch) await processTranslate(s, guidelines, characterMemo) }
    try {
      const combined = batch.map(s => s.formatted).join('\n\n')
      const firstId = batch[0].id
      const idx = scenesRef.current.findIndex(s => s.id === firstId)
      const prev = idx > 0 ? scenesRef.current[idx - 1] : null
      const prevTail = prev ? prev.raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
      const _b = await postJSON('/api/translate', {
        formattedText: combined, prevTail,
        characterMemo: characterMemo || null, guidelines,
        totalScenes: scenesRef.current.length,
        model: loadSettings().translateModel || loadSettings().model,
      })
      const raw = cleanOutput(_b.translated)
      const parts = splitByHeading(raw)
      if (parts.length !== batch.length) { await fallback(); return } // 안전: 개수 안 맞으면 개별로
      batch.forEach((s, i) => {
        // 자막 교체 안 함 — 정렬 메타(검토용)만
        const matches = smiEntriesRef.current ? alignSmi(parts[i], smiEntriesRef.current).matches : []
        updateScene(s.id, { status: 'done', translated: parts[i], smiMatches: matches, batched: true,
          tokens: { ...s.tokens, translate_in: estTokens(s.formatted), translate_out: estTokens(parts[i]) } })
      })
    } catch (e) {
      if (e.code === 'RATE_LIMIT') { setIsRateLimited(true); isPausedRef.current = true; setIsPaused(true) }
      await fallback()
    }
  }

  async function translateScenes(guidelines, characterMemo, settings) {
    const pending = scenesRef.current.filter(s => s.formatted && s.status !== 'done')
    const batches = buildBatches(pending, settings.batchShort !== false)
    await runWithConcurrency(batches, async (batch) => {
      if (isStoppedRef.current) return
      await waitWhilePaused()
      if (batch.length === 1) await processTranslate(batch[0], guidelines, characterMemo)
      else await processTranslateBatch(batch, guidelines, characterMemo)
    }, settings.concurrency)
  }

  function waitWhilePaused() {
    return new Promise(resolve => {
      const check = () => isPausedRef.current ? setTimeout(check, 300) : resolve()
      check()
    })
  }

  async function runWithConcurrency(items, fn, concurrency) {
    const queue = [...items]
    const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
      while (queue.length > 0) {
        if (isStoppedRef.current) return
        await waitWhilePaused()
        if (isStoppedRef.current) return
        await fn(queue.shift())
      }
    })
    await Promise.all(workers)
  }

  // Step 1: 각본 파일 불러오기 (API 호출 없음, 씬 분할만)
  async function handleLoad({ scriptFile, smiFile, title: t }) {
    setTitle(t)
    setStep('extracting')

    let smiLines = null
    if (smiFile) {
      try {
        const txt = await decodeSubtitle(smiFile)        // UTF-8/EUC-KR 자동
        smiLines = parseSubtitleLines(txt)               // SMI/SRT 공통
        smiLinesRef.current = smiLines
        smiEntriesRef.current = parseSMIEntries(txt)      // 한글 매칭용
        const info = subtitleInfo(smiLines)
        setSmiInfo(info)
        // 줄이 거의 없을 때만 경고 (영어 자막도 정상 허용)
        setSmiWarning(smiLines.length < 5
          ? `자막을 ${smiLines.length}줄밖에 못 읽었어요. 파일 형식·인코딩을 확인해 주세요.` : null)
      } catch (e) {
        setSmiInfo(null)
        setSmiWarning('자막 파일을 읽는 중 오류가 발생했습니다. 파일 형식을 확인해 주세요.')
        console.warn('자막 파싱 오류:', e.message)
      }
      setReviewSmiFile(smiFile)
    }

    // 추출 — 깨진/스캔/iCloud 미다운로드 PDF에서 무한대기 방지 (타임아웃 + 에러 가드)
    let rawText, candidates
    try {
      const result = await Promise.race([
        extractText(scriptFile, (cur, total) => setExtractProgress({ cur, total, label: '' })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 90000)),
      ])
      rawText = result.text; candidates = result.candidates
    } catch (e) {
      setStep('upload')
      window.alert(
        e.message === 'TIMEOUT'
          ? '파일 읽기가 너무 오래 걸려 중단했어요.\n\niCloud에 있는 파일이면 Finder에서 먼저 완전히 다운로드(☁️ 아이콘)한 뒤 다시 올려주세요. 또는 로컬 폴더(다운로드 등)로 복사해서 올려보세요.'
          : `파일을 읽을 수 없어요: ${e.message}\n\nPDF가 손상됐거나 iCloud 미다운로드 파일일 수 있어요.`
      )
      return
    }
    if (!rawText || rawText.replace(/\s/g, '').length < 20) {
      const ext = scriptFile.name.split('.').pop().toLowerCase()
      if (ext === 'pdf') {
        // 텍스트 레이어가 비었음 = 스캔(이미지) PDF → 서버에서 OCR (몇 분 걸릴 수 있어 90초 race 밖에서)
        try {
          setExtractProgress({ cur: 0, total: 0, label: '스캔 PDF — OCR로 글자 읽는 중 (1~2분 걸릴 수 있어요)' })
          rawText = await ocrPdfViaServer(scriptFile)
          candidates = []
        } catch (e) {
          setStep('upload')
          window.alert(e.ocrMissing
            ? '스캔(이미지) PDF예요. 자동 OCR 도구가 없어 글자를 읽지 못했어요.\n\n터미널에서 다음을 설치한 뒤 다시 시도해 주세요:\nbrew install poppler tesseract'
            : `스캔 PDF OCR에 실패했어요: ${e.message}`)
          return
        }
        if (!rawText || rawText.replace(/\s/g, '').length < 20) {
          setStep('upload')
          window.alert('OCR했지만 글자를 거의 못 읽었어요.\n\n스캔 화질이 낮거나 손글씨일 수 있어요.')
          return
        }
      } else {
        setStep('upload')
        window.alert('이 파일에서 텍스트를 거의 못 읽었어요.\n\niCloud에 안 받아진 껍데기 파일일 수 있어요. 텍스트가 들어있는 파일로 다시 시도해 주세요.')
        return
      }
    }

    // formatted.txt 감지 → 포맷 완료 상태로 바로 로드
    const ext = scriptFile.name.split('.').pop().toLowerCase()
    if (ext === 'txt' && detectFileType(rawText) === 'formatted') {
      const rawScenes = rawText.split(/\n(?=# )/).filter(s => s.trim()).map((raw, i) => ({
        id: i, raw,
        status: 'formatted', formatted: raw,
        translated: null, tokens: null, error: null,
        heading: raw.split('\n')[0].trim(),
      }))
      setPdfWarnings([])
      setReviewScenes(rawScenes)
      setStep('review')
      return
    }

    // PDF이고 후보가 있으면 LLM으로 씬 헤딩 정밀 감지
    let rawScenes = null
    const isPdf = scriptFile.name.toLowerCase().endsWith('.pdf')
    // 진단: 어떻게 읽고 처리했는지 기록 (오류 추적·학습용)
    const diag = {
      title: t, file: scriptFile.name, ext,
      rawLines: rawText.split('\n').length, candidates: candidates.length,
      method: null, aiReturned: null, aiKept: null, aiDropped: null, aiError: null,
    }
    let aiScenes = null
    if (isPdf && candidates.length > 0) {
      setExtractProgress({ cur: candidates.length, total: 0, label: '씬 구조 분석 중...' })
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 120000) // 2분 넘으면 포기 → 무한대기 방지
      try {
        const res = await fetch('/api/detect-headings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidates }),
          signal: ctrl.signal,
        })
        if (res.ok) {
          const { indices } = await res.json()
          // LLM 오탐(페이지번호·캐릭터큐·지문) 제거 — 진짜 헤딩만
          const lines = rawText.split('\n')
          const good = indices.filter(i => isLikelyHeading(lines[i]))
          diag.aiReturned = indices.length
          diag.aiKept = good.length
          diag.aiDropped = indices.length - good.length
          if (good.length > 1) aiScenes = splitByHeadingIndices(rawText, good)
        }
      } catch (e) {
        diag.aiError = (e.message || '').slice(0, 80)
        console.warn('detect-headings 실패/시간초과, regex fallback:', e.message)
      } finally {
        clearTimeout(to)
      }
    }

    // 규칙 분할도 항상 계산 — 들여쓰기 헤딩·OCR 잡티에 강하고 x좌표 무관(AI 후보 누락 보완)
    const ruleScenes = splitIntoScenes(rawText)
    // 더 나은 쪽 선택: 표준 헤딩(INT./EXT. 등)을 더 많이 인식한 결과를 채택
    const headedCount = list => (list || []).filter(s => isLikelyHeading((s.raw.split('\n').find(l => l.trim()) || ''))).length
    const aiH = headedCount(aiScenes), ruleH = headedCount(ruleScenes)
    if (aiScenes && aiH >= ruleH) {
      rawScenes = aiScenes; diag.method = 'ai'
    } else {
      rawScenes = ruleScenes; diag.method = aiScenes ? 'ai→regex' : 'regex'
    }
    diag.aiHeadings = aiH; diag.ruleHeadings = ruleH
    diag.scenes = rawScenes.length

    const warnings = analyzeScenes(rawScenes, rawText)
    diag.warnings = warnings.map(w => w.code)
    setProcessInfo(diag)
    diagRef.current = diag  // 로그는 완료 시점/수동 리포트 때만 (취소·초기에러 노이즈 방지)
    setPdfWarnings(warnings)
    const scenes = rawScenes.map(s => ({
      ...s, status: 'pending', formatted: null, translated: null, tokens: null, error: null, heading: null
    }))
    setReviewScenes(scenes)
    setStep('review')
  }

  // 진행 폴링 — 서버 잡 상태를 주기적으로 읽어 UI 반영. 일은 서버가 하므로
  // 폴링이 멈춰도(탭 닫힘/최소화) 작업엔 무관. 다시 열면 이어서 폴링.
  function stopPolling() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  function startPolling(id) {
    serverJobRef.current = id
    stopPolling()
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${id}`)
        if (!res.ok) return
        const job = await res.json()
        scenesRef.current = job.scenes
        setScenes(job.scenes)
        setPhase(job.phase)
        if (job.title) setTitle(job.title)
        if (job.startTime) setStartTime(job.startTime)
        setTimeInfo({ activeMs: job.activeMs || 0, runningSince: job._runStart || null })
        if (job.characterMemo !== undefined) { characterMemoRef.current = job.characterMemo; setCharacterMemo(job.characterMemo || '') }
        if (job.profile !== undefined) setProfile(job.profile)
        const paused = job.status === 'paused' || job.status === 'rate_limited'
        isPausedRef.current = paused
        setIsPaused(paused)
        setIsRateLimited(job.status === 'rate_limited')
        if (job.status === 'done' || job.status === 'stopped' || job.status === 'error') {
          stopPolling()
          isProcessing.current = false
          setPhase('done'); setStep('done')
        }
      } catch {}
    }
    tick()
    pollRef.current = setInterval(tick, document.hidden ? 5000 : 1500)
  }

  // 홈 잡 목록에서 작업 열기 — 서버 잡 모니터로 진입 (백그라운드에서 돌던 작업 재진입)
  function handleOpenJob(jobId) {
    isProcessing.current = true
    isStoppedRef.current = false
    serverJobRef.current = jobId
    jobIdRef.current = jobId
    setStep('processing')
    startPolling(jobId)  // tick이 scenes/phase/title/step 채움
  }

  // 말투 가이드(글로서리) 저장
  async function handleSaveGlossary(memo) {
    const id = serverJobRef.current
    if (!id) return
    characterMemoRef.current = memo; setCharacterMemo(memo)
    try { await fetch(`/api/jobs/${id}/glossary`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memo }) }) } catch {}
  }

  // 작품 전체 새 설계로 다시 번역 (keepGlossary: 현 말투 가이드 유지 / false: 새로 생성)
  async function handleRetranslate(keepGlossary) {
    const id = serverJobRef.current
    if (!id) return
    isProcessing.current = true
    isStoppedRef.current = false; isPausedRef.current = false
    setIsPaused(false); setIsRateLimited(false)
    setStep('processing'); setPhase('formatting')
    try { await fetch(`/api/jobs/${id}/retranslate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepGlossary }) }) } catch {}
    startPolling(id)
  }

  // 잡 제어 (일시정지/재개/중단) → 서버 엔드포인트
  async function jobControl(action) {
    const id = serverJobRef.current
    if (!id) return null
    try {
      const res = await fetch(`/api/jobs/${id}/${action}`, { method: 'POST' })
      return res.ok ? await res.json() : null
    } catch { return null }
  }

  // 백그라운드/포그라운드 전환 시 폴링 주기 조절 (작업은 서버가 계속)
  useEffect(() => {
    const onVis = () => { if (pollRef.current && serverJobRef.current) startPolling(serverJobRef.current) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Step 2: 검토 후 변환 시작 — 서버에 잡 생성 후 폴링. (루프는 서버가 소유)
  async function handleStart(characterMemo) {
    characterMemoRef.current = characterMemo || ''
    // 표시·처리 모두 긴 씬을 청크 분할한 결과 기준
    const initialScenes = forceSplitScenes(reviewScenes)
    scenesRef.current = initialScenes
    setScenes(initialScenes)
    const st = Date.now()
    setStartTime(st)
    setStep('processing')
    setPhase('formatting')
    isProcessing.current = true
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    setIsRateLimited(false)

    const settings = loadSettings()
    const payload = {
      title,
      scenes: initialScenes.map(s => ({
        id: s.id, raw: s.raw,
        status: s.status === 'formatted' ? 'formatted' : 'pending',
        formatted: s.formatted || null, heading: s.heading || null,
      })),
      smi: smiLinesRef.current
        ? { lines: smiLinesRef.current, entries: smiEntriesRef.current, info: smiInfo }
        : null,
      settings,
      guidelines: { format: loadGuidelines('format'), translate: loadGuidelines('translate') },
      characterMemo: characterMemo || '',
    }
    try {
      const res = await postJSON('/api/jobs', payload)
      serverJobRef.current = res.jobId
      jobIdRef.current = res.jobId
      startPolling(res.jobId)
    } catch (e) {
      window.alert('작업 생성 실패: ' + e.message)
      setStep('review')
      isProcessing.current = false
    }
  }

  // 수동 문제 리포트 — 모달로 입력
  const handleReport = useCallback(() => { setReportNote(''); setReportSaved(false); setReportOpen(true) }, [])
  function submitReport() {
    const cur = scenesRef.current || []
    logProcess({
      ...(diagRef.current || {}), event: 'report', manual: true, note: reportNote || '',
      doneCount: cur.filter(s => s.status === 'done').length,
      total: cur.length,
      errorScenes: cur.filter(s => s.status.startsWith('error')).slice(0, 10).map(s => ({ id: s.id, error: (s.error || '').slice(0, 120) })),
    })
    setReportSaved(true)
    setTimeout(() => setReportOpen(false), 700)
  }

  // 수정 모드: 기존 txt → 씬 분리 → Claude 수정
  async function handleStartRevise({ text, title: t, mode }) {
    const rawScenes = text.split(/\n(?=# )/).filter(s => s.trim())
    const initialScenes = rawScenes.map((raw, i) => ({
      id: i, raw,
      status: 'pending', formatted: null, translated: null, tokens: null, error: null,
      heading: raw.split('\n')[0].trim(),
    }))

    const st = Date.now()
    setTitle(t)
    setScenes(initialScenes)
    scenesRef.current = initialScenes
    setStartTime(st)
    jobIdRef.current = st
    isProcessing.current = true
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    setIsRateLimited(false)
    setStep('processing')
    setPhase('formatting')

    const guidelines = loadGuidelines(mode === 'translated' ? 'translate' : 'format')

    await runWithConcurrency(initialScenes, async (s) => {
      if (isStoppedRef.current) return
      await waitWhilePaused()
      updateScene(s.id, { status: 'formatting' })
      try {
        const res = await fetch('/api/revise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneText: s.raw, guidelines, mode, sceneIndex: s.id, totalScenes: initialScenes.length }),
        })
        if (!res.ok) {
          const body = await res.json()
          if (body.code === 'RATE_LIMIT') { setIsRateLimited(true); isPausedRef.current = true; setIsPaused(true) }
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        const { revised } = await res.json()
        updateScene(s.id, { status: 'done', formatted: revised, translated: revised })
      } catch (e) {
        updateScene(s.id, { status: 'error_format', error: e.message })
      }
    }, loadSettings().concurrency)

    isProcessing.current = false
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    setPhase('done')
    setStep('done')
  }

  async function handleContinue() {
    // 서버 잡이면 서버에서 재개 (미완 씬부터)
    if (serverJobRef.current) {
      isProcessing.current = true
      isStoppedRef.current = false
      isPausedRef.current = false
      setIsPaused(false); setIsRateLimited(false)
      setStep('processing'); setPhase('translating')
      await jobControl('resume')
      startPolling(serverJobRef.current)
      return
    }
    // formatting/translating 중 멈춘 씬 리셋 (done은 절대 건드리지 않음)
    scenesRef.current
      .filter(s => s.status === 'formatting' || s.status === 'translating')
      .forEach(s => updateScene(s.id, { status: s.formatted ? 'formatted' : 'pending' }))

    // 스냅샷 고정 — done 명시적으로 제외
    const remaining = scenesRef.current.filter(s =>
      s.status !== 'done' && (
        s.status === 'pending' || s.status === 'formatted' || s.status.startsWith('error')
      )
    )
    if (remaining.length === 0) return
    isProcessing.current = true
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    setIsRateLimited(false)
    setPhase('translating')
    setStep('processing')

    const settings = loadSettings()
    const fmtGuidelines = loadGuidelines('format')
    const transGuidelines = loadGuidelines('translate')

    await runWithConcurrency(remaining, async (s) => {
      if (s.status === 'pending' || s.status === 'error_format') {
        const ok = await processFormat(s, fmtGuidelines)
        if (ok) {
          const updated = scenesRef.current.find(x => x.id === s.id)
          if (updated?.formatted) await processTranslate(updated, transGuidelines, null)
        }
      } else if (s.status === 'formatted' || s.status === 'error_translate') {
        await processTranslate(s, transGuidelines, null)
      }
    }, settings.concurrency)

    isProcessing.current = false
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    setPhase('done')
    setStep('done')
    const snap = scenesRef.current
    saveHistory({ id: jobIdRef.current, title, sceneCount: snap.length, sceneData: snap, startTime, duration: Date.now() - (startTime || Date.now()) })
  }

  async function handleRetry(sceneId) {
    // 서버 잡이면 브라우저 fetch로 재시도하지 말고(=Load failed 원인) 서버 재개로 일임
    if (serverJobRef.current) { handleContinue(); return }
    const scene = scenesRef.current.find(s => s.id === sceneId)
    if (!scene) return
    isProcessing.current = true
    const settings = loadSettings()
    if (scene.status === 'error_format') {
      const ok = await processFormat(scene, loadGuidelines('format'))
      if (ok) {
        const updated = scenesRef.current.find(s => s.id === sceneId)
        if (updated?.status === 'formatted') await processTranslate(updated, loadGuidelines('translate'), characterMemoRef.current)
      }
    } else if (scene.status === 'error_translate') {
      await processTranslate(scene, loadGuidelines('translate'), characterMemoRef.current)
    }
    isProcessing.current = false
  }

  async function handleReprocess(sceneId) {
    const scene = scenesRef.current.find(s => s.id === sceneId)
    if (!scene) return
    isProcessing.current = true
    const settings = loadSettings()
    const reset = { ...scene, status: 'pending', formatted: null, translated: null, tokens: null, error: null }
    setScenes(prev => { const next = prev.map(s => s.id === sceneId ? reset : s); scenesRef.current = next; return next })
    const ok = await processFormat(reset, loadGuidelines('format'))
    if (ok) {
      const updated = scenesRef.current.find(s => s.id === sceneId)
      if (updated?.status === 'formatted') await processTranslate(updated, loadGuidelines('translate'), characterMemoRef.current)
    }
    isProcessing.current = false
  }

  // 구조 깨진(영문↔번역 마커·줄 수 불일치) 완료 씬을 찾아 한 번에 재번역.
  // 포맷은 그대로 두고 번역만 다시 — processTranslate에 가드가 있어 통과 못 하면 error_translate로 뜸.
  async function handleReprocessBroken() {
    const broken = scenesRef.current.filter(s =>
      s.status === 'done' && s.formatted && s.translated && !translationStructureOk(s.formatted, s.translated))
    if (!broken.length) { alert('구조가 깨진 씬이 없어요.'); return }
    if (!window.confirm(`구조가 깨진 ${broken.length}개 씬을 다시 번역할까요? (포맷은 그대로, 번역만 다시 — 토큰 사용)`)) return
    isProcessing.current = true
    isStoppedRef.current = false
    for (const s of broken) {
      if (isStoppedRef.current) break
      const cur = scenesRef.current.find(x => x.id === s.id)
      if (cur) await processTranslate(cur, loadGuidelines('translate'), characterMemoRef.current)
    }
    isProcessing.current = false
  }

  // 직전 저장 내용 기억 → 변동 없으면 중복 저장 안 함
  const lastDownloadRef = useRef({})
  function handleDownload(type) {
    const text = scenesRef.current.filter(s => s[type]).map(s => s[type]).join('\n\n')
    if (lastDownloadRef.current[type] === text) return 'unchanged'  // 바뀐 게 없음 → 저장 스킵
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${title}_${type}.txt`; a.click()
    URL.revokeObjectURL(url)
    lastDownloadRef.current[type] = text
    return 'saved'
  }

  function handlePause() {
    isPausedRef.current = true
    setIsPaused(true)
    jobControl('pause')
  }

  function handleResume() {
    isPausedRef.current = false
    setIsPaused(false)
    setIsRateLimited(false)
    if (serverJobRef.current) {
      jobControl('resume')
      if (!pollRef.current) startPolling(serverJobRef.current)
    }
  }

  function handleStop() {
    isStoppedRef.current = true
    isPausedRef.current = false
    isProcessing.current = false
    setIsPaused(false)
    if (serverJobRef.current) jobControl('stop')
    stopPolling()
    setPhase('done')
    setStep('done')
  }

  function handleReset() {
    clearSession()
    stopPolling()
    serverJobRef.current = null
    setStep('upload'); setScenes([]); scenesRef.current = []
    setTitle(''); setPhase(''); smiLinesRef.current = null; setStartTime(null)
    setReviewScenes([]); setPdfWarnings([])
  }

  function handleLogoClick() {
    // 이미 홈이면 새로고침으로 깔끔히 초기화
    if (step === 'upload') { window.location.reload(); return }
    // 서버 잡은 홈으로 가도 백그라운드에서 계속 — 목록에서 다시 열 수 있음
    if (isProcessing.current && !serverJobRef.current) {
      if (!window.confirm('작업이 진행 중입니다. 중단하고 홈으로 돌아갈까요?')) return
      isProcessing.current = false
    }
    stopPolling()
    setStep('upload')
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.fg }}>
      <div style={{
        padding: '14px 0', borderBottom: `1px solid ${T.rule}`,
        position: 'sticky', top: 0, background: T.bg, zIndex: 10,
      }}>
       <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        maxWidth: 640, margin: '0 auto', padding: '0 20px', boxSizing: 'border-box',
       }}>
        <span onClick={handleLogoClick} className="sr-logo" title="홈으로"
          style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 700, fontSize: 15, letterSpacing: '-.3px', cursor: 'pointer' }}>
          <svg width="36" height="13" viewBox="0 0 36 13" aria-hidden>
            <rect className="trio trio-sq" x="0.5" y="1.5" width="10" height="10" fill={T.trans} />
            <circle className="trio trio-ci" cx="18" cy="6.5" r="5.6" fill={T.warn} />
            <path className="trio trio-tri" d="M30 1.2l5.3 10.6H24.7z" fill={T.fmt} />
          </svg>
          <span>scriptroom<span style={{ color: T.accent }}>convert</span></span>
        </span>
        <button onClick={() => setShowSettings(true)} className="sr-press" style={navBtn}>설정</button>
       </div>
      </div>

      {claudeMissing && (
        <div style={{ background: T.err + '18', borderBottom: `1px solid ${T.err}55`, padding: '10px 20px', color: T.err, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700 }}>⚠ Claude Code가 안 보여요</span>
          <span style={{ color: T.fgMuted }}>번역이 안 돌아갑니다 — <b>claude.com/claude-code</b> 설치 후 터미널에서 <code>claude</code> 실행해 로그인하세요. (서버 재시작 필요)</span>
        </div>
      )}

      {step === 'upload' && (
        <UploadStep
          onLoad={handleLoad}
          onRevise={handleStartRevise}
          onOpenJob={handleOpenJob}
          onRestore={session => {
            setTitle(session.title); setScenes(session.scenes)
            scenesRef.current = session.scenes; setStartTime(session.startTime)
            smiLinesRef.current = session.smiLines || null
            jobIdRef.current = session.jobId || null
            setPhase('done'); setStep('processing')
          }}
        />
      )}

      {step === 'extracting' && (() => {
        const analyzing = extractProgress.label?.includes('분석')
        // 분석중 단계별 문구 (정직하게 — 길어지면 과장 없이 안내)
        const phases = ['씬 경계 찾는 중', '대사·지문 구분 중', '구조 정리 중']
        const phaseIdx = analyzing ? Math.min(2, Math.floor(extractElapsed / 10)) : -1
        const mainLabel = analyzing
          ? (extractElapsed >= 30 ? '긴 각본이라 분석이 길어지고 있어요' : (phases[Math.floor(extractElapsed / 10)] || phases[phases.length - 1]))
          : (extractProgress.label || '파일 불러오는 중...')
        // 단계가 진행될수록 점프가 빨라짐
        const jumpDur = analyzing ? [2.6, 2.1, 1.7][phaseIdx] : 3
        return (
          <div style={{ padding: '64px 24px', textAlign: 'center', '--err': T.err, '--warn': T.warn, '--fmt': T.fmt }}>
            <svg viewBox="0 0 116 46" width="116" height="46" style={{ display: 'block', margin: '0 auto 22px', '--hop': `${jumpDur}s`, overflow: 'visible' }} aria-hidden>
              <rect className="bh bh-sq" x="6" y="12" width="26" height="26" fill={T.trans} />
              <circle className="bh bh-ci" cx="58" cy="25" r="14" fill={T.warn} />
              <polygon className="bh bh-tri" points="86,10 102,38 70,38" fill={T.fmt} />
            </svg>
            <div style={{ color: T.fg, fontSize: 15, marginBottom: 6 }}>
              {mainLabel}<span style={{ color: T.fgMuted }}>{'.'.repeat((extractElapsed % 3) + 1)}</span>
              {extractElapsed > 0 && <span style={{ color: T.fgMuted, fontWeight: 400 }}>  ·  {extractElapsed}초</span>}
            </div>
            {extractProgress.total > 0 && !extractProgress.label && (
              <div style={{ color: T.fgMuted, fontSize: 13 }}>{extractProgress.cur} / {extractProgress.total} 페이지</div>
            )}
            {analyzing && (
              <div style={{ color: T.fgDim, fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
                {extractProgress.cur > 0 && <>{extractProgress.cur}줄 분석 · </>}
                각본이 길면 1분 넘게 걸릴 수 있어요. 끝나면 자동으로 넘어가요.
                {extractElapsed >= 110 && <div style={{ color: T.warn, marginTop: 4 }}>오래 걸리네요 — 곧 기본 방식으로 자동 전환돼요.</div>}
              </div>
            )}
          </div>
        )
      })()}

      {step === 'review' && (
        <ReviewStep
          title={title}
          scenes={reviewScenes}
          smiFile={reviewSmiFile}
          smiWarning={smiWarning}
          pdfWarnings={pdfWarnings}
          processInfo={processInfo}
          smiInfo={smiInfo}
          onStart={handleStart}
          onBack={() => setStep('upload')}
        />
      )}

      {(step === 'processing' || step === 'done') && (
        <ProcessPanel
          title={title} scenes={scenes} phase={phase} startTime={startTime} timeInfo={timeInfo}
          isPaused={isPaused} isRateLimited={isRateLimited}
          characterMemo={characterMemo} profile={profile} isServerJob={!!serverJobRef.current}
          onSaveGlossary={handleSaveGlossary} onRetranslate={handleRetranslate}
          onPause={handlePause} onResume={handleResume} onStop={handleStop} onContinue={handleContinue}
          onReader={() => { setReaderStartIdx(0); setReaderOpen(true) }}
          onRetry={handleRetry} onReprocess={handleReprocess} onReprocessBroken={handleReprocessBroken}
          onDownload={handleDownload} onReset={handleReset} onReport={handleReport}
        />
      )}

      {reportOpen && (
        <div onClick={() => setReportOpen(false)}
          style={{ position: 'fixed', inset: 0, background: '#000b', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120, padding: 20, animation: 'fadeIn .15s ease' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, background: T.bgCard, borderRadius: 3, border: `1px solid ${T.rule}`, padding: 20, animation: 'popIn .18s ease' }}>
            <div style={{ color: T.fg, fontWeight: 700, fontSize: 16, marginBottom: 6 }}>문제 리포트</div>
            <div style={{ color: T.fgDim, fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
              어떤 점이 이상한지 적어 주세요 (선택). 이 작업의 처리 정보가 함께 기록되어 나중에 원인을 찾는 데 쓰입니다.
            </div>
            <textarea value={reportNote} onChange={e => setReportNote(e.target.value)} autoFocus
              placeholder={'예: 12번 씬 대사가 지문으로 합쳐졌어요'}
              style={{ width: '100%', minHeight: 96, resize: 'vertical', boxSizing: 'border-box',
                background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg,
                fontSize: 14, padding: 12, lineHeight: 1.5, outline: 'none' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={() => setReportOpen(false)} style={{ flex: 1, padding: '11px', borderRadius: 3, border: `1px solid ${T.rule}`, background: 'none', color: T.fgMuted, fontSize: 14, cursor: 'pointer' }}>취소</button>
              <button onClick={submitReport} style={{ flex: 2, padding: '11px', borderRadius: 3, border: 'none', background: reportSaved ? T.good : T.accent, color: T.accentFg, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                {reportSaved ? '기록됨 ✓' : '기록'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} themeName={themeName} onToggleTheme={toggleTheme} accentKey={accentKey} onAccent={changeAccent} />}
      {readerOpen && <ReaderMode scenes={scenes} initialIndex={readerStartIdx} onClose={() => setReaderOpen(false)} />}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(24px); opacity: .4 } to { transform: translateY(0); opacity: 1 } }
        @keyframes popIn { from { transform: scale(.94); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        @keyframes riseIn { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

        /* 트리오 도형 — 정지(홈 심볼 idle 애니메이션 없음). transform 기준점만 설정. */
        .trio { transform-box: fill-box; transform-origin: 50% 50%; }

        /* 드롭존 — 호버 시 은은한 그림자 (도형은 ShapeField가 마우스 반발로 반응) */
        .sr-drop { transition: box-shadow .25s ease, border-color .15s; }
        .sr-drop:hover { box-shadow: 0 6px 22px rgba(0,0,0,.06); }

        /* 버튼 — 슬며시 뜨고 눌리는 반응 */
        .sr-press { transition: transform .14s ease, filter .14s ease, box-shadow .14s ease; }
        .sr-press:hover  { transform: translateY(-1px); filter: brightness(1.06); }
        .sr-press:active { transform: translateY(0) scale(.97); filter: brightness(.97); }

        /* 주요 CTA(불러오기 등) — 들리지 않고, 부드러운 글로우 링 + 누름 */
        .sr-cta { transition: box-shadow .22s ease, transform .12s ease, filter .2s ease; }
        .sr-cta:hover  { box-shadow: 0 0 0 3px rgba(30,77,140,.16), 0 4px 14px rgba(30,77,140,.22); filter: brightness(1.03); }
        .sr-cta:active { transform: scale(.985); }

        /* 카드 — 호버 시 살짝 밀림 */
        .sr-card { transition: transform .16s ease, border-color .16s ease, background .16s ease; }
        .sr-card:hover { transform: translateX(2px); }

        /* 분석 화면 — 바우하우스 3원색 도형(사각·원·삼각)이 바닥에서 차례로 통통, 색은 3원색 순환 */
        @keyframes bhHop {
          0%, 58%, 100% { transform: translateY(0); }
          73% { transform: translateY(-13px); }
          86% { transform: translateY(0); }
        }
        @keyframes bhHue {
          0%, 100% { fill: var(--err); }
          33%      { fill: var(--warn); }
          66%      { fill: var(--fmt); }
        }
        .bh { transform-box: fill-box; transform-origin: 50% 100%;
          animation: bhHop var(--hop, 2.6s) cubic-bezier(.3,.7,.4,1) infinite, bhHue 4.5s steps(1) infinite; }
        .bh-ci  { animation-delay: .16s, 1.5s; }
        .bh-tri { animation-delay: .32s, 3s; }
        @media (prefers-reduced-motion: reduce) {
          .bh { animation: none; }
          .bh-sq { fill: var(--err); } .bh-ci { fill: var(--warn); } .bh-tri { fill: var(--fmt); }
        }
      `}</style>
    </div>
  )
}

