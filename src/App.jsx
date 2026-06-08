import { useState, useCallback, useRef, useEffect } from 'react'
import { T, loadGuidelines, saveHistory, loadSettings, sliceSmi, loadPromptsFromFile, logProcess } from './lib/core.js'
import { extractText, splitIntoScenes, splitByHeadingIndices, parseSMI, isLikelyHeading, forceSplitScenes } from './lib/pdf.js'
import { ruleFormat } from './lib/format-rules.js'
import { analyzeScenes } from './lib/analyze.js'
import { parseSMIEntries, matchSmiToTranslation, decodeSubtitle, parseSubtitleLines, subtitleInfo } from './lib/smi.js'
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

export default function App() {
  const session = loadSession()
  const [step, setStep] = useState(session ? 'processing' : 'upload') // upload | extracting | review | processing | done | revising
  const [title, setTitle] = useState(session?.title || '')
  const [scenes, setScenes] = useState(session?.scenes || [])
  const [reviewScenes, setReviewScenes] = useState([]) // 검토용 씬 (raw만, API 전)
  const [reviewSmiFile, setReviewSmiFile] = useState(null)
  const [pdfWarnings, setPdfWarnings] = useState([])
  const [phase, setPhase] = useState(session ? 'done' : '')
  const [startTime, setStartTime] = useState(session?.startTime || null)
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
  const diagRef = useRef(null)  // 이번 작업의 처리 진단 (완료 시/수동 리포트 시 기록)
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
      if (isProcessing.current) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // 자막 컨텍스트: 씬 길이에 비례해 가변 슬라이싱 (짧은 씬은 적게 → 토큰 절감)
  function getSmiContext(scene, totalScenes) {
    if (!smiLinesRef.current) return null
    const lines = scene.raw.split('\n').filter(Boolean).length
    const win = Math.min(120, Math.max(25, Math.round(lines * 1.4)))
    return sliceSmi(smiLinesRef.current, scene.id, totalScenes, win)
  }

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
      const heading = rf.formatted.split('\n')[0].trim()
      updateScene(scene.id, {
        status: 'formatted', formatted: rf.formatted, formatMethod: 'rule',
        heading: heading.startsWith('#') ? heading : null,
        tokens: { format_in: 0, format_out: 0 },
      })
      return true
    }
    try {
      const fs = loadSettings()
      const { formatted, tokens } = await postJSON('/api/format', {
        sceneText: scene.raw, guidelines, sceneIndex: scene.id,
        totalScenes: scenesRef.current.length, model: fs.formatModel || fs.model,
      })
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
      const smiContext = getSmiContext(scene, scenesRef.current.length)
      // 직전 씬 끝부분 — 대명사·상황 맥락 (처리 순서 무관하게 raw 사용)
      const idx = scenesRef.current.findIndex(s => s.id === scene.id)
      const prev = idx > 0 ? scenesRef.current[idx - 1] : null
      const prevTail = prev ? prev.raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
      const { translated: rawTranslated, tokens } = await postJSON('/api/translate', {
        formattedText: scene.formatted, smiContext, prevTail,
        smiAuthoritative: smiInfo?.lang === 'ko',  // KO 자막이면 대사는 자막 우선
        characterMemo: characterMemo || null, guidelines,
        sceneIndex: scene.id, totalScenes: scenesRef.current.length,
        model: loadSettings().translateModel || loadSettings().model,
      })
      // SMI 매칭: 번역 완료 후 대사 라인을 자막과 비교·교체
      const { text: translated, matches: smiMatches } = smiEntriesRef.current
        ? matchSmiToTranslation(rawTranslated, smiEntriesRef.current)
        : { text: rawTranslated, matches: [] }
      updateScene(scene.id, {
        status: 'done', translated, smiMatches,
        tokens: { ...scene.tokens, translate_in: estTokens(scene.formatted) + estTokens(smiContext || ''), translate_out: estTokens(rawTranslated) },
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
      const totalLines = batch.reduce((a, s) => a + s.raw.split('\n').filter(Boolean).length, 0)
      const smiContext = smiLinesRef.current
        ? sliceSmi(smiLinesRef.current, firstId, scenesRef.current.length, Math.min(160, Math.max(40, Math.round(totalLines * 1.4))))
        : null
      const idx = scenesRef.current.findIndex(s => s.id === firstId)
      const prev = idx > 0 ? scenesRef.current[idx - 1] : null
      const prevTail = prev ? prev.raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
      const { translated: raw } = await postJSON('/api/translate', {
        formattedText: combined, smiContext, prevTail,
        smiAuthoritative: smiInfo?.lang === 'ko',
        characterMemo: characterMemo || null, guidelines,
        totalScenes: scenesRef.current.length,
        model: loadSettings().translateModel || loadSettings().model,
      })
      const parts = splitByHeading(raw)
      if (parts.length !== batch.length) { await fallback(); return } // 안전: 개수 안 맞으면 개별로
      batch.forEach((s, i) => {
        const { text, matches } = smiEntriesRef.current
          ? matchSmiToTranslation(parts[i], smiEntriesRef.current)
          : { text: parts[i], matches: [] }
        updateScene(s.id, { status: 'done', translated: text, smiMatches: matches, batched: true,
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

    const { text: rawText, candidates } = await extractText(scriptFile, (cur, total) => {
      setExtractProgress({ cur, total, label: '' })
    })

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
          if (good.length > 1) { rawScenes = splitByHeadingIndices(rawText, good); diag.method = 'ai' }
        }
      } catch (e) {
        diag.aiError = (e.message || '').slice(0, 80)
        console.warn('detect-headings 실패/시간초과, regex fallback:', e.message)
      } finally {
        clearTimeout(to)
      }
    }
    // LLM 실패하거나 PDF 아닌 경우 regex fallback
    if (!rawScenes || rawScenes.length <= 1) {
      rawScenes = splitIntoScenes(rawText)
      diag.method = diag.method === 'ai' ? 'ai→regex' : 'regex'
    }
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

  // Step 2: 검토 후 변환 시작
  async function handleStart(characterMemo) {
    characterMemoRef.current = characterMemo || ''
    // 표시는 논리적 씬(reviewScenes), 처리는 긴 씬을 80줄 청크로 분할해서 돌림
    const initialScenes = forceSplitScenes(reviewScenes)
    scenesRef.current = initialScenes
    setScenes(initialScenes)
    const st = Date.now()
    setStartTime(st)
    saveSession({ title, scenes: initialScenes, startTime: st, smiLines: smiLinesRef.current })
    setStep('processing')
    isProcessing.current = true
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    jobIdRef.current = st

    const settings = loadSettings()
    const fmtGuidelines = loadGuidelines('format')
    const transGuidelines = loadGuidelines('translate')

    const allFormatted = initialScenes.every(s => s.status === 'formatted' && s.formatted)

    // 1단계: 포맷 (규칙 우선 → 대부분 0토큰). formatted.txt 로드면 건너뜀.
    if (!allFormatted) {
      setPhase('formatting')
      await runWithConcurrency(initialScenes, async (s) => {
        if (isStoppedRef.current) return
        await waitWhilePaused()
        if (s.status !== 'formatted') await processFormat(s, fmtGuidelines)
      }, settings.concurrency)
    }

    // 2단계: 번역 (짧은 씬 배칭 → 호출수 절감, 개수 안 맞으면 개별 폴백)
    if (!isStoppedRef.current) {
      setPhase('translating')
      await translateScenes(transGuidelines, characterMemo, settings)
    }

    isProcessing.current = false
    isPausedRef.current = false
    isStoppedRef.current = false
    setIsPaused(false)
    setPhase('done')
    setStep('done')

    const finalScenes = scenesRef.current
    const { totalIn, totalOut } = finalScenes.reduce((acc, s) => ({
      totalIn: acc.totalIn + (s.tokens?.format_in || 0) + (s.tokens?.translate_in || 0),
      totalOut: acc.totalOut + (s.tokens?.format_out || 0) + (s.tokens?.translate_out || 0),
    }), { totalIn: 0, totalOut: 0 })
    saveHistory({ id: jobIdRef.current, title, sceneCount: finalScenes.length, sceneData: finalScenes, startTime: st, duration: Date.now() - st })

    // 작업 마무리 시점에만 진단 로그 기록 (의미 있는 완료 기록)
    logProcess({
      ...(diagRef.current || {}), event: 'done',
      doneCount: finalScenes.filter(s => s.status === 'done').length,
      total: finalScenes.length,
      errors: finalScenes.filter(s => s.status.startsWith('error')).length,
      durationMs: Date.now() - st,
    })
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

  function handleDownload(type) {
    const text = scenesRef.current.filter(s => s[type]).map(s => s[type]).join('\n\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${title}_${type}.txt`; a.click()
    URL.revokeObjectURL(url)
  }

  function handlePause() {
    isPausedRef.current = true
    setIsPaused(true)
  }

  function handleResume() {
    isPausedRef.current = false
    setIsPaused(false)
    setIsRateLimited(false)
  }

  function handleStop() {
    isStoppedRef.current = true
    isPausedRef.current = false
    isProcessing.current = false
    setIsPaused(false)
    setPhase('done')
    setStep('done')
    const snap = scenesRef.current
    saveHistory({ id: jobIdRef.current, title, sceneCount: snap.length, sceneData: snap, startTime, duration: Date.now() - (startTime || Date.now()) })
  }

  function handleReset() {
    clearSession()
    setStep('upload'); setScenes([]); scenesRef.current = []
    setTitle(''); setPhase(''); smiLinesRef.current = null; setStartTime(null)
    setReviewScenes([]); setPdfWarnings([])
  }

  function handleLogoClick() {
    if (step === 'upload') return
    if (isProcessing.current) {
      if (!window.confirm('작업이 진행 중입니다. 중단하고 홈으로 돌아갈까요?')) return
      isProcessing.current = false
    }
    setStep('upload')
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.fg }}>
      {/* 바우하우스 3원색 스트라이프 */}
      <div style={{ display: 'flex', height: 5, position: 'sticky', top: 0, zIndex: 11 }}>
        <div style={{ flex: 1, background: '#C0392B' }} />
        <div style={{ flex: 1, background: '#D9A400' }} />
        <div style={{ flex: 1, background: '#1E4D8C' }} />
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', borderBottom: `3px solid #1A1A1A`,
        position: 'sticky', top: 5, background: T.bg, zIndex: 10,
      }}>
        <span onClick={handleLogoClick}
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: step !== 'upload' ? 'pointer' : 'default' }}>
          {/* 바우하우스 기하 마크: 빨강 네모 · 노랑 원 · 파랑 삼각 */}
          <svg width="42" height="16" viewBox="0 0 42 16" aria-hidden>
            <rect x="0" y="2" width="12" height="12" fill="#C0392B" />
            <circle cx="21" cy="8" r="6.5" fill="#D9A400" />
            <path d="M36 1.5l6.5 13H29.5z" fill="#1E4D8C" />
          </svg>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-.4px' }}>
            scriptroom <span style={{ color: T.accent }}>convert</span>
          </span>
        </span>
        <button onClick={() => setShowSettings(true)} style={navBtn}>설정</button>
      </div>

      {step === 'upload' && (
        <UploadStep
          onLoad={handleLoad}
          onRevise={handleStartRevise}
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
        const mainLabel = analyzing
          ? (extractElapsed >= 30 ? '긴 각본이라 분석이 길어지고 있어요' : (phases[Math.floor(extractElapsed / 10)] || phases[phases.length - 1]))
          : (extractProgress.label || '파일 불러오는 중...')
        return (
          <div style={{ padding: '60px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, marginBottom: 12, animation: 'spin 1.4s linear infinite', display: 'inline-block' }}>⟳</div>
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
          title={title} scenes={scenes} phase={phase} startTime={startTime}
          isPaused={isPaused} isRateLimited={isRateLimited}
          onPause={handlePause} onResume={handleResume} onStop={handleStop} onContinue={handleContinue}
          onReader={() => { setReaderStartIdx(0); setReaderOpen(true) }}
          onRetry={handleRetry} onReprocess={handleReprocess}
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

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {readerOpen && <ReaderMode scenes={scenes} initialIndex={readerStartIdx} onClose={() => setReaderOpen(false)} />}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(24px); opacity: .4 } to { transform: translateY(0); opacity: 1 } }
        @keyframes popIn { from { transform: scale(.94); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        @keyframes riseIn { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
      `}</style>
    </div>
  )
}

const navBtn = {
  padding: '6px 14px', borderRadius: 3,
  background: 'transparent', border: `2px solid #1A1A1A`,
  color: '#1A1A1A', fontSize: 13, fontWeight: 700, cursor: 'pointer',
}
