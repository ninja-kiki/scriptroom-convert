import { useState, useCallback, useRef, useEffect } from 'react'
import { T, loadGuidelines, saveHistory, loadSettings, sliceSmi } from './lib/core.js'
import { extractText, splitIntoScenes, parseSMI } from './lib/pdf.js'
import UploadStep from './components/UploadStep.jsx'
import ReviewStep from './components/ReviewStep.jsx'
import ProcessPanel from './components/ProcessPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'

const SESSION_KEY = 'convert_session'
function saveSession(data) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)) } catch {} }
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null } }
function clearSession() { localStorage.removeItem(SESSION_KEY) }

export default function App() {
  const session = loadSession()
  const [step, setStep] = useState(session ? 'processing' : 'upload') // upload | extracting | review | processing | done
  const [title, setTitle] = useState(session?.title || '')
  const [scenes, setScenes] = useState(session?.scenes || [])
  const [reviewScenes, setReviewScenes] = useState([]) // 검토용 씬 (raw만, API 전)
  const [reviewSmiFile, setReviewSmiFile] = useState(null)
  const [phase, setPhase] = useState(session ? 'done' : '')
  const [startTime, setStartTime] = useState(session?.startTime || null)
  const [showSettings, setShowSettings] = useState(false)
  const [extractProgress, setExtractProgress] = useState({ cur: 0, total: 0 })
  const smiLinesRef = useRef(session?.smiLines || null)
  const scenesRef = useRef(session?.scenes || [])
  const isProcessing = useRef(false)

  const updateScene = useCallback((id, patch) => {
    setScenes(prev => {
      const next = prev.map(s => s.id === id ? { ...s, ...patch } : s)
      scenesRef.current = next
      saveSession({ title, scenes: next, startTime, smiLines: smiLinesRef.current })
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { translated, tokens } = await res.json()
      updateScene(scene.id, {
        status: 'done', translated,
        tokens: { ...scene.tokens, translate_in: tokens?.input ?? 0, translate_out: tokens?.output ?? 0 },
      })
      return true
    } catch (e) {
      updateScene(scene.id, { status: 'error_translate', error: e.message })
      return false
    }
  }

  async function runWithConcurrency(items, fn, concurrency) {
    const queue = [...items]
    const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
      while (queue.length > 0) await fn(queue.shift())
    })
    await Promise.all(workers)
  }

  // Step 1: 각본 파일 불러오기 (API 호출 없음, 씬 분할만)
  async function handleLoad({ scriptFile, smiFile, title: t }) {
    setTitle(t)
    setStep('extracting')

    let smiLines = null
    if (smiFile) {
      const txt = await smiFile.text()
      smiLines = parseSMI(txt).split('\n').filter(Boolean)
      smiLinesRef.current = smiLines
      setReviewSmiFile(smiFile)
    }

    const rawText = await extractText(scriptFile, (cur, total) => {
      setExtractProgress({ cur, total })
    })

    const rawScenes = splitIntoScenes(rawText)
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

    const settings = loadSettings()
    const fmtGuidelines = loadGuidelines('format')
    const transGuidelines = loadGuidelines('translate')

    setPhase('formatting')
    await runWithConcurrency(initialScenes, async (s) => {
      const ok = await processFormat(s, fmtGuidelines)
      if (ok) {
        setPhase('translating')
        const updated = scenesRef.current.find(x => x.id === s.id)
        if (updated?.formatted) await processTranslate(updated, transGuidelines, characterMemo)
      }
    }, settings.concurrency)

    isProcessing.current = false
    setPhase('done')
    setStep('done')

    const finalScenes = scenesRef.current
    const { totalIn, totalOut } = finalScenes.reduce((acc, s) => ({
      totalIn: acc.totalIn + (s.tokens?.format_in || 0) + (s.tokens?.translate_in || 0),
      totalOut: acc.totalOut + (s.tokens?.format_out || 0) + (s.tokens?.translate_out || 0),
    }), { totalIn: 0, totalOut: 0 })
    saveHistory({ title, scenes: initialScenes.length, duration: Date.now() - st })
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

  function handleReset() {
    clearSession()
    setStep('upload'); setScenes([]); scenesRef.current = []
    setTitle(''); setPhase(''); smiLinesRef.current = null; setStartTime(null)
    setReviewScenes([])
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
          onRestore={session => {
            setTitle(session.title); setScenes(session.scenes)
            scenesRef.current = session.scenes; setStartTime(session.startTime)
            smiLinesRef.current = session.smiLines || null
            setPhase('done'); setStep('processing')
          }}
        />
      )}

      {step === 'extracting' && (
        <div style={{ padding: '60px 24px', textAlign: 'center' }}>
          <div style={{ color: T.fgMuted, marginBottom: 8 }}>파일 불러오는 중...</div>
          {extractProgress.total > 0 && (
            <div style={{ color: T.fg }}>{extractProgress.cur} / {extractProgress.total} 페이지</div>
          )}
        </div>
      )}

      {step === 'review' && (
        <ReviewStep
          title={title}
          scenes={reviewScenes}
          smiFile={reviewSmiFile}
          onStart={handleStart}
          onBack={() => setStep('upload')}
        />
      )}

      {(step === 'processing' || step === 'done') && (
        <ProcessPanel
          title={title} scenes={scenes} phase={phase} startTime={startTime}
          onRetry={handleRetry} onReprocess={handleReprocess}
          onDownload={handleDownload} onReset={handleReset}
        />
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

const navBtn = {
  padding: '6px 12px', borderRadius: 6,
  background: T.chip, border: `1px solid ${T.rule}`,
  color: T.fgMuted, fontSize: 13, cursor: 'pointer',
}
