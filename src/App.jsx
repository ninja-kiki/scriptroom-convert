import { useState, useCallback, useRef, useEffect } from 'react'
import { T, loadGuidelines, saveHistory, loadSettings, sliceSmi } from './lib/core.js'
import { extractText, splitIntoScenes, splitByHeadingIndices, parseSMI } from './lib/pdf.js'
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
  const scenesRef = useRef(session?.scenes || [])
  const jobIdRef = useRef(session?.jobId || null)
  const isProcessing = useRef(false)
  const isPausedRef = useRef(false)
  const isStoppedRef = useRef(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isRateLimited, setIsRateLimited] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerStartIdx, setReaderStartIdx] = useState(0)

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

  function getSmiContext(sceneIndex, totalScenes) {
    if (!smiLinesRef.current) return null
    return sliceSmi(smiLinesRef.current, sceneIndex, totalScenes, 60)
  }

  async function processFormat(scene, guidelines) {
    updateScene(scene.id, { status: 'formatting' })
    try {
      const res = await fetch('/api/format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneText: scene.raw, guidelines, sceneIndex: scene.id, totalScenes: scenesRef.current.length, model: loadSettings().model }),
      })
      if (!res.ok) {
        const body = await res.json()
        if (body.code === 'RATE_LIMIT') {
          setIsRateLimited(true)
          isPausedRef.current = true
          setIsPaused(true)
        }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const { formatted, tokens } = await res.json()
      const heading = formatted.split('\n')[0].trim()
      updateScene(scene.id, {
        status: 'formatted', formatted,
        heading: heading.startsWith('#') ? heading : null,
        tokens: { format_in: tokens?.input ?? 0, format_out: tokens?.output ?? 0 },
      })
      return true
    } catch (e) {
      updateScene(scene.id, { status: 'error_format', error: e.message })
      return false
    }
  }

  async function processTranslate(scene, guidelines, characterMemo) {
    updateScene(scene.id, { status: 'translating' })
    try {
      const smiContext = getSmiContext(scene.id, scenesRef.current.length)
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formattedText: scene.formatted, smiContext,
          characterMemo: characterMemo || null, guidelines,
          sceneIndex: scene.id, totalScenes: scenesRef.current.length,
          model: loadSettings().model,
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        if (body.code === 'RATE_LIMIT') {
          setIsRateLimited(true)
          isPausedRef.current = true
          setIsPaused(true)
        }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const { translated: rawTranslated, tokens } = await res.json()
      // SMI 매칭: 번역 완료 후 대사 라인을 자막과 비교·교체
      const { text: translated, matches: smiMatches } = smiEntriesRef.current
        ? matchSmiToTranslation(rawTranslated, smiEntriesRef.current)
        : { text: rawTranslated, matches: [] }
      updateScene(scene.id, {
        status: 'done', translated, smiMatches,
        tokens: { ...scene.tokens, translate_in: tokens?.input ?? 0, translate_out: tokens?.output ?? 0 },
      })
      return true
    } catch (e) {
      updateScene(scene.id, { status: 'error_translate', error: e.message })
      return false
    }
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
    if (isPdf && candidates.length > 0) {
      setExtractProgress({ cur: 0, total: 0, label: '씬 구조 분석 중...' })
      try {
        const res = await fetch('/api/detect-headings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidates }),
        })
        if (res.ok) {
          const { indices } = await res.json()
          if (indices.length > 1) rawScenes = splitByHeadingIndices(rawText, indices)
        }
      } catch (e) {
        console.warn('detect-headings 실패, regex fallback:', e.message)
      }
    }
    // LLM 실패하거나 PDF 아닌 경우 regex fallback
    if (!rawScenes || rawScenes.length <= 1) rawScenes = splitIntoScenes(rawText)

    const warnings = analyzeScenes(rawScenes, rawText)
    setPdfWarnings(warnings)
    const scenes = rawScenes.map(s => ({
      ...s, status: 'pending', formatted: null, translated: null, tokens: null, error: null, heading: null
    }))
    setReviewScenes(scenes)
    setStep('review')
  }

  // Step 2: 검토 후 변환 시작
  async function handleStart(characterMemo) {
    const initialScenes = reviewScenes
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

    if (allFormatted) {
      // formatted.txt에서 로드된 경우: 포맷 단계 건너뛰고 바로 번역
      setPhase('translating')
      await runWithConcurrency(initialScenes, async (s) => {
        await processTranslate(s, transGuidelines, characterMemo)
      }, settings.concurrency)
    } else {
      setPhase('formatting')
      await runWithConcurrency(initialScenes, async (s) => {
        const ok = await processFormat(s, fmtGuidelines)
        if (ok) {
          setPhase('translating')
          const updated = scenesRef.current.find(x => x.id === s.id)
          if (updated?.formatted) await processTranslate(updated, transGuidelines, characterMemo)
        }
      }, settings.concurrency)
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
        if (updated?.status === 'formatted') await processTranslate(updated, loadGuidelines('translate'), settings.characterMemo)
      }
    } else if (scene.status === 'error_translate') {
      await processTranslate(scene, loadGuidelines('translate'), settings.characterMemo)
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
      if (updated?.status === 'formatted') await processTranslate(updated, loadGuidelines('translate'), settings.characterMemo)
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
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', borderBottom: `1px solid ${T.rule}`,
        position: 'sticky', top: 0, background: T.bg, zIndex: 10,
      }}>
        <span onClick={handleLogoClick}
          style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-.3px', cursor: step !== 'upload' ? 'pointer' : 'default' }}>
          scriptroom <span style={{ color: T.accent }}>convert</span>
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

      {step === 'extracting' && (
        <div style={{ padding: '60px 24px', textAlign: 'center' }}>
          <div style={{ color: T.fgMuted, marginBottom: 8 }}>
            {extractProgress.label || '파일 불러오는 중...'}
          </div>
          {extractProgress.total > 0 && !extractProgress.label && (
            <div style={{ color: T.fg }}>{extractProgress.cur} / {extractProgress.total} 페이지</div>
          )}
        </div>
      )}

      {step === 'review' && (
        <ReviewStep
          title={title}
          scenes={reviewScenes}
          smiFile={reviewSmiFile}
          smiWarning={smiWarning}
          pdfWarnings={pdfWarnings}
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
          onDownload={handleDownload} onReset={handleReset}
        />
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {readerOpen && <ReaderMode scenes={scenes} initialIndex={readerStartIdx} onClose={() => setReaderOpen(false)} />}

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

const navBtn = {
  padding: '6px 12px', borderRadius: 6,
  background: T.chip, border: `1px solid ${T.rule}`,
  color: T.fgMuted, fontSize: 13, cursor: 'pointer',
}
