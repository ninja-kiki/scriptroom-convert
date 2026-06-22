import { useRef, useState, useEffect } from 'react'
import { T, loadHistory, deleteHistory, fmtDuration, fmtTokens, loadGuidelines, loadSettings } from '../lib/core.js'
import { decodeSubtitle, parseSubtitleLines, subtitleInfo } from '../lib/smi.js'
import LintPanel from './LintPanel.jsx'
import ShapeField from './ShapeField.jsx'
import { detectIssues, detectFileType, planLLMChunks, estimateTokens, applyAutoFixes, patchText, parseFeedback, classifyFeedback, applyDirectEdits } from '../lib/revise.js'

const SESSION_KEY = 'convert_session'
const SCRIPT_EXTS = ['pdf', 'txt', 'fdx', 'fountain', 'rtf']
const SMI_EXTS = ['smi', 'srt']

function getExt(file) {
  return file.name.split('.').pop().toLowerCase()
}

function titleFromFile(file) {
  return file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
}

// 서버 잡 상태 → 한글 라벨·색
const JOB_STATUS = {
  running: { label: '진행 중', color: T.warn },
  paused: { label: '일시정지 · 이어하기 가능', color: T.fgMuted },
  rate_limited: { label: '사용량 한도 — 대기', color: T.err },
  done: { label: '완료', color: T.good },
  stopped: { label: '중단됨 · 이어하기 가능', color: T.fgDim },
  error: { label: '오류', color: T.err },
}

export default function UploadStep({ onLoad, onRestore, onRevise, onOpenJob }) {
  const scriptRef = useRef()
  const smiRef = useRef()
  const reviseRef = useRef()
  const [tab, setTab] = useState('convert') // convert | revise
  const [scriptFile, setScriptFile] = useState(null)
  const [smiFile, setSmiFile] = useState(null)
  const [smiMeta, setSmiMeta] = useState(null)  // { lang, count } 불러온 자막 감지 결과
  const [dragOverScript, setDragOverScript] = useState(false)
  const [dragOverSmi, setDragOverSmi] = useState(false)
  const [smiWarning, setSmiWarning] = useState(false)
  const [history, setHistory] = useState(() => loadHistory())
  const [jobs, setJobs] = useState([])  // 서버 잡 목록 (멀티세션)
  const [showHistory, setShowHistory] = useState(false)  // 레거시 이전기록은 기본 접힘
  const [loading, setLoading] = useState(false)

  // 서버 잡 목록 폴링 — 백그라운드에서 도는 여러 작품의 진행을 홈에서 실시간 표시
  useEffect(() => {
    if (tab !== 'convert') return
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/jobs')
        if (res.ok && alive) setJobs(await res.json())
      } catch {}
    }
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [tab])

  async function handleDeleteJob(id, e) {
    e.stopPropagation()
    const job = jobs.find(j => j.id === id)
    if (!window.confirm(`"${job?.title}" 작업을 목록에서 삭제할까요?`)) return
    try { await fetch(`/api/jobs/${id}`, { method: 'DELETE' }) } catch {}
    setJobs(prev => prev.filter(j => j.id !== id))
  }
  // 수정 모드
  const [reviseFile, setReviseFile] = useState(null)
  const [dragOverRevise, setDragOverRevise] = useState(false)
  const [reviseIssues, setReviseIssues] = useState(null)
  const [reviseSelected, setReviseSelected] = useState([])
  const [reviseText, setReviseText] = useState('')
  const [reviseDone, setReviseDone] = useState(false)
  const [reviseFileType, setReviseFileType] = useState(null)
  const [userInstruction, setUserInstruction] = useState('')
  const [llmChunks, setLlmChunks] = useState([])
  const [llmProgress, setLlmProgress] = useState(null) // null | { done, total }
  const [reviseRunning, setReviseRunning] = useState(false)
  // 검수 피드백 파일 (B: _feedback.txt)
  const [feedbackFile, setFeedbackFile] = useState(null)
  const [feedbackItems, setFeedbackItems] = useState(null)
  const [dragOverFeedback, setDragOverFeedback] = useState(false)
  const feedbackRef = useRef()
  const feedbackClass = feedbackItems ? classifyFeedback(feedbackItems) : null
  // 리더 '수정요청.json' → Max LLM 수정 → 오버레이.json
  const [fixReq, setFixReq] = useState(null)
  const [fixRunning, setFixRunning] = useState(false)
  const [fixProgress, setFixProgress] = useState(null)
  const fixReqRef = useRef()
  async function handleFixReqSelect(file) {
    if (!file) return
    try {
      const obj = JSON.parse(await file.text())
      if (!Array.isArray(obj.items)) { alert('수정요청 JSON 형식이 아니에요.'); return }
      setFixReq(obj)
    } catch { alert('JSON을 읽을 수 없어요.') }
  }
  async function runFixReq() {
    if (!fixReq?.items?.length) return
    setFixRunning(true); setFixProgress({ done: 0, total: fixReq.items.length })
    const guidelines = loadGuidelines('translate')
    const model = (loadSettings().translateModel || loadSettings().model)
    const edits = {}
    for (let i = 0; i < fixReq.items.length; i++) {
      const it = fixReq.items[i]
      if (it.ko) {
        const note = [it.tags?.length ? `[${it.tags.join('·')}]` : '', it.memo || ''].filter(Boolean).join(' ')
        try {
          const res = await fetch('/api/fix-feedback', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ko: it.ko, en: it.en, note, guidelines, model }),
          })
          if (res.ok) { const { fixed } = await res.json(); if (fixed && fixed !== it.ko) edits[it.blockId] = fixed }
        } catch {}
      }
      setFixProgress({ done: i + 1, total: fixReq.items.length })
    }
    const blob = new Blob([JSON.stringify({ id: fixReq.id, title: fixReq.title, edits }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${fixReq.id || 'overlay'}_수정.json`; a.click()
    URL.revokeObjectURL(url)
    setFixRunning(false); setFixProgress(null)
    alert(`${Object.keys(edits).length}개 수정 완료 → 리더에서 '수정 가져오기'로 반영하세요.`)
  }

  const currentSession = (() => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
  })()

  function handleScriptFile(file) {
    if (!file) return
    if (SMI_EXTS.includes(getExt(file))) { handleSmiFile(file); return }
    if (!SCRIPT_EXTS.includes(getExt(file))) return
    setScriptFile(file)
    setSmiWarning(false)
  }

  async function handleSmiFile(file) {
    if (!file || !SMI_EXTS.includes(getExt(file))) return
    setSmiFile(file)
    setSmiWarning(false)
    setSmiMeta(null)
    try {
      const txt = await decodeSubtitle(file)
      setSmiMeta(subtitleInfo(parseSubtitleLines(txt)))
    } catch { setSmiMeta({ lang: 'unknown', count: 0 }) }
  }

  // 여러 파일을 한 번에 드롭 — 확장자로 자동 분류 (PDF+자막 동시 가능)
  function routeFiles(fileList) {
    for (const f of Array.from(fileList || [])) {
      if (SMI_EXTS.includes(getExt(f))) handleSmiFile(f)
      else if (SCRIPT_EXTS.includes(getExt(f))) handleScriptFile(f)
    }
  }

  function handleScriptDrop(e) {
    e.preventDefault()
    setDragOverScript(false)
    routeFiles(e.dataTransfer.files)
  }

  function handleSmiDrop(e) {
    e.preventDefault()
    setDragOverSmi(false)
    routeFiles(e.dataTransfer.files)
  }

  function handleDelete(id, e) {
    e.stopPropagation()
    const entry = history.find(h => h.id === id)
    if (!window.confirm(`"${entry?.title}" 기록을 삭제할까요?`)) return
    deleteHistory(id)
    setHistory(loadHistory())
  }

  async function handleReviseFileSelect(file) {
    if (!file || !file.name.endsWith('.txt')) return
    setReviseFile(file); setReviseDone(false); setReviseIssues(null)
    setLlmChunks([]); setLlmProgress(null)
    const text = await file.text()
    setReviseText(text)
    const fileType = detectFileType(text)
    setReviseFileType(fileType)
    const issues = detectIssues(text)
    setReviseIssues(issues)
    setReviseSelected(issues.map(i => i.id))
  }

  async function handleFeedbackSelect(file) {
    if (!file || !file.name.endsWith('.txt')) return
    setReviseDone(false)
    const text = await file.text()
    const items = parseFeedback(text)
    setFeedbackFile(file)
    setFeedbackItems(items)
  }

  function handleInstructionChange(val) {
    setUserInstruction(val)
    if (!reviseText) return
    const chunks = val.trim() ? planLLMChunks(reviseText, val) : []
    setLlmChunks(chunks)
  }

  async function handleReviseApply() {
    setReviseRunning(true)
    setReviseDone(false)

    // 1. 자동 수정
    let result = applyAutoFixes(reviseText, reviseSelected)

    // 1.5 검수 피드백의 '수정됨'(직접수정) 적용 — LLM 0토큰
    let directApplied = 0
    if (feedbackItems?.length) {
      const dr = applyDirectEdits(result, feedbackItems)
      result = dr.text
      directApplied = dr.applied.length
    }

    // 1.7 검수 피드백의 '해석필요'(태그·메모만) — 블록별 LLM 내용수정 후 치환
    const llmFeedback = feedbackClass?.llm || []
    if (llmFeedback.length) {
      setLlmProgress({ done: 0, total: llmFeedback.length })
      const guidelines = loadGuidelines('translate')
      const edited = []
      for (let i = 0; i < llmFeedback.length; i++) {
        const it = llmFeedback[i]
        if (it.ko) {
          const note = it.marks.map(m => `[${m.tags.join('·')}]${m.memo ? ' ' + m.memo : ''}`).join(' / ')
          try {
            const res = await fetch('/api/fix-feedback', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ko: it.ko, en: it.en, note, guidelines }),
            })
            if (res.ok) {
              const { fixed } = await res.json()
              if (fixed && fixed !== it.ko) edited.push({ ...it, edited: fixed })
            }
          } catch {}
        }
        setLlmProgress({ done: i + 1, total: llmFeedback.length })
      }
      if (edited.length) result = applyDirectEdits(result, edited).text
    }

    // 2. LLM 패치 (사용자 지시사항 있을 때)
    if (llmChunks.length > 0 && userInstruction.trim()) {
      setLlmProgress({ done: 0, total: llmChunks.length })
      const patchResults = []
      for (let i = 0; i < llmChunks.length; i++) {
        const chunk = llmChunks[i]
        try {
          const res = await fetch('/api/patch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chunk: chunk.lines.join('\n'),
              instruction: userInstruction,
              fileType: reviseFileType,
            }),
          })
          if (res.ok) {
            const { patched } = await res.json()
            patchResults.push({ startLine: chunk.startLine, endLine: chunk.endLine, patched })
          }
        } catch {}
        setLlmProgress({ done: i + 1, total: llmChunks.length })
      }
      result = patchText(result, patchResults)
    }

    // 3. 다운로드
    const blob = new Blob([result], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = reviseFile.name.replace('.txt', '_수정.txt'); a.click()
    URL.revokeObjectURL(url)
    setReviseDone(true); setReviseRunning(false); setLlmProgress(null)
  }

  function toggleReviseSelect(id) {
    setReviseSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function handleLoad() {
    if (!scriptFile) return
    if (!smiFile && !smiWarning) {
      setSmiWarning(true)
      return
    }
    setLoading(true)
    await onLoad({ scriptFile, smiFile, title: titleFromFile(scriptFile) })
    setLoading(false)
  }

  return (
    <div style={{ padding: '28px 20px', maxWidth: 640, margin: '0 auto' }}>

      {/* 탭 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
        {[{ id: 'convert', label: '변환' }, { id: 'revise', label: '수정' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className="sr-press" style={{
            padding: '7px 18px', borderRadius: 3, border: 'none', cursor: 'pointer',
            background: tab === t.id ? T.accent : T.chip,
            color: tab === t.id ? T.accentFg : T.fgMuted,
            fontWeight: 700, fontSize: 14,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'revise' && (
        <div>
          {/* 번역본 검수 (코드 기반, 토큰 0) */}
          <LintPanel />

        </div>
      )}

      {tab === 'convert' && (
      <div>
      {/* 드롭존 — 각본 + 자막 한 번에 */}
      <div
        onClick={() => !scriptFile && scriptRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOverScript(true) }}
        onDragLeave={() => setDragOverScript(false)}
        onDrop={handleScriptDrop}
        className={!scriptFile ? 'sr-drop' : undefined}
        style={{
          position: 'relative', overflow: 'hidden',
          border: 'none',
          borderRadius: 3, padding: '22px 24px',
          minHeight: scriptFile ? 158 : 300, boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          textAlign: 'center', cursor: scriptFile ? 'default' : 'pointer',
          background: dragOverScript ? T.accent + '22' : T.bgCard,
          boxShadow: dragOverScript ? `inset 0 0 0 2px ${T.accent}` : 'none',
          transition: 'transform .25s ease, box-shadow .25s ease, border-color .2s, background .2s', marginBottom: 16,
        }}
      >
        {scriptFile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left' }}>
            {/* 각본 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ color: T.accent, fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scriptFile.name}</div>
                <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                  {(scriptFile.size / 1024 / 1024).toFixed(1)} MB · {getExt(scriptFile).toUpperCase()}
                </div>
              </div>
              <button onClick={e => { e.stopPropagation(); setScriptFile(null); setSmiWarning(false) }}
                style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            {/* 자막 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${T.rule}`, paddingTop: 10 }}>
              {smiFile ? (
                <>
                  <span style={{ color: T.good, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{smiFile.name}</span>
                  {smiMeta && (
                    <span style={{
                      flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                      background: T.chip,
                      color: smiMeta.lang === 'ko' ? T.accent : smiMeta.lang === 'en' ? T.fgMuted : T.fgDim,
                    }}>
                      {smiMeta.lang === 'ko' ? '한글 자막' : smiMeta.lang === 'en' ? '영어 자막' : '인식 실패'} · {smiMeta.count}줄
                    </span>
                  )}
                  <button onClick={e => { e.stopPropagation(); setSmiFile(null); setSmiWarning(false); setSmiMeta(null) }}
                    style={{ background: 'none', border: 'none', color: T.fgDim, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
                </>
              ) : (
                <>
                  <span style={{ color: T.fgDim, fontSize: 13, flex: 1 }}>자막 없음</span>
                  <button onClick={e => { e.stopPropagation(); smiRef.current.click() }}
                    style={{ background: 'none', border: `1px solid ${T.rule}`, color: T.fgMuted, fontSize: 12, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }}>자막 추가</button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* 바우하우스 도형들이 흩뿌려진 인터랙티브 배경 — 마우스가 들어오면 피해 달아남 */}
            <ShapeField size={58} />
            <div style={{ position: 'relative', zIndex: 1, pointerEvents: 'none' }}>
              <div style={{ color: T.fg, fontWeight: 700, fontSize: 16, letterSpacing: '-.2px', marginBottom: 6 }}>각본 자막을 올리세요</div>
              <div style={{ color: T.fgDim, fontSize: 12.5, lineHeight: 1.5 }}>
                <span style={{ color: T.fgMuted, fontWeight: 600 }}>각본</span> PDF · TXT · RTF · FDX · Fountain
                <span style={{ margin: '0 7px', color: T.rule }}>|</span>
                <span style={{ color: T.fgMuted, fontWeight: 600 }}>자막</span> SMI · SRT <span style={{ color: T.fgDim }}>(선택)</span>
              </div>
            </div>
          </>
        )}
        <input ref={scriptRef} type="file" accept=".pdf,.txt,.rtf,.fdx,.fountain,.smi,.srt" multiple hidden
          onChange={e => routeFiles(e.target.files)} />
        <input ref={smiRef} type="file" accept=".smi,.srt" hidden onChange={e => handleSmiFile(e.target.files[0] || null)} />
      </div>

      {/* 경고: SMI 없음 */}
      {smiWarning && (
        <div style={{
          marginBottom: 12, padding: '12px 14px', borderRadius: 3,
          background: T.bgCard, border: `1px solid ${T.accent}55`,
        }}>
          <div style={{ color: T.accent, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>SMI 자막 없이 진행할까요?</div>
          <div style={{ color: T.fgMuted, fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
            자막 파일이 있으면 번역 품질이 높아집니다.<br />
            <span style={{ color: T.fgDim }}>opensubtitles.org · subscene.com · viki.com 등에서 구할 수 있습니다.</span>
          </div>
          <button onClick={handleLoad} style={{
            padding: '7px 14px', borderRadius: 3, border: `1px solid ${T.accent}66`,
            background: 'none', color: T.accent, fontSize: 13, cursor: 'pointer', fontWeight: 500,
          }}>
            {loading ? '불러오는 중...' : '자막 없이 시작'}
          </button>
        </div>
      )}

      {scriptFile && (
        <button
          disabled={loading}
          onClick={handleLoad}
          className="sr-cta"
          style={{
            width: '100%', padding: '12px', borderRadius: 3, border: 'none',
            background: loading ? T.chip : T.accent,
            color: loading ? T.fgDim : T.accentFg,
            fontWeight: 700, fontSize: 15, cursor: loading ? 'default' : 'pointer',
            marginBottom: 28, animation: 'riseIn .2s ease',
          }}
        >
          {loading ? '불러오는 중...' : '불러오기'}
        </button>
      )}

      {/* 작업 — 서버 잡(멀티세션, 백그라운드 진행) + 이전 로컬 기록 */}
      {(() => {
      // 작업(서버 jobs)에 이미 있는 건 이전기록에서 숨김 — 중복 제거
      const jobKeys = new Set(jobs.flatMap(j => [j.id, j.title]))
      const visibleHistory = history.filter(h => !jobKeys.has(h.id) && !jobKeys.has(h.title))
      return (jobs.length > 0 || visibleHistory.length > 0) && (
        <div>
          {jobs.length > 0 && <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 8 }}>작업</div>}

          {jobs.map(j => {
            const st = JOB_STATUS[j.status] || { label: j.status, color: T.fgMuted }
            // 완료됐는데 오류가 남아있으면 진짜 완료가 아님 — '미완료(오류)'로 취급
            const incomplete = j.status === 'done' && j.errors > 0
            const trulyDone = j.status === 'done' && !incomplete
            const resumable = j.status === 'paused' || j.status === 'stopped' || incomplete
            return (
              <div key={j.id} onClick={() => onOpenJob(j.id)} className="sr-card" style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '11px 14px', background: (j.status === 'running' || j.status === 'paused' || trulyDone) ? T.bgCard : T.bgMuted,
                borderRadius: 3,
                cursor: 'pointer', marginBottom: 6,
              }}>
                {j.status === 'running'
                  ? <svg width="14" height="14" viewBox="0 0 14 14" style={{ flexShrink: 0, margin: '0 3px' }}><polygon points="2,1 13,7 2,13" fill={T.warn} /></svg>
                  : (j.status === 'paused' || j.status === 'stopped')
                    ? <svg width="14" height="14" viewBox="0 0 14 14" style={{ flexShrink: 0, margin: '0 3px' }}><rect x="1" y="1" width="12" height="12" rx="1" fill={T.fgDim} /></svg>
                    : resumable
                      ? <svg width="14" height="14" viewBox="0 0 14 14" style={{ flexShrink: 0, margin: '0 3px' }}><polygon points="2,1 13,7 2,13" fill={incomplete ? T.err : T.accent} /></svg>
                      : <span style={{ width: 14, height: 14, borderRadius: 999, background: st.color, flexShrink: 0, display: 'inline-block', margin: '0 3px' }} />}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ color: T.fg, fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</div>
                  <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                    {j.done}/{j.total}씬 · {incomplete
                      ? <span style={{ color: T.err, fontWeight: 600 }}>오류 {j.errors} · 미완료</span>
                      : <><span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>{j.errors > 0 && <span style={{ color: T.err }}> · 오류 {j.errors}</span>}</>}
                  </div>
                </div>
                <button onClick={e => handleDeleteJob(j.id, e)}
                  style={{ background: 'none', border: 'none', color: T.fgDim, cursor: 'pointer', fontSize: 18, padding: '2px 4px' }}>×</button>
              </div>
            )
          })}

          {visibleHistory.length > 0 && (
            <button onClick={() => setShowHistory(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer',
                color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', margin: '16px 0 8px', padding: 0 }}>
              이전 기록 {visibleHistory.length} <span style={{ fontSize: 10 }}>{showHistory ? '▲' : '▼'}</span>
            </button>
          )}

          {showHistory && visibleHistory.map(h => {
            // 저장된 doneCount 우선 (완료작은 sceneData를 버리므로 다시 세면 0이 됨)
            const doneCount = h.doneCount ?? (h.sceneData ? h.sceneData.filter(s => s.status === 'done').length : 0)
            const total = h.sceneCount ?? (h.sceneData ? h.sceneData.length : 0)
            const isComplete = total > 0 && doneCount >= total
            const canResume = !!h.sceneData && total > 0 && !isComplete

            const icon = canResume
              ? <span style={{ color: T.accent, fontSize: 16, flexShrink: 0, width: 20, textAlign: 'center' }}>▶</span>
              : <span style={{ width: 14, height: 14, borderRadius: 999, background: isComplete ? T.good : T.fgDim, flexShrink: 0, display: 'inline-block', margin: '0 3px' }} />
            return (
              <div key={h.id} className={canResume ? 'sr-card' : undefined} onClick={canResume ? () => onRestore({ title: h.title, scenes: h.sceneData, startTime: h.startTime, jobId: h.id, smiLines: null }) : undefined} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: isComplete ? T.bgCard : T.bgMuted,
                borderRadius: 3, marginBottom: 6,
                cursor: canResume ? 'pointer' : 'default',
              }}>
                {icon}
                <div style={{ flex: 1 }}>
                  <div style={{ color: canResume ? T.accent : T.fg, fontWeight: 500, fontSize: 14 }}>{h.title}</div>
                  <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                    {isComplete ? `${total}씬 완료` : `${doneCount}/${total}씬`}
                    {' · '}{new Date(h.id).toLocaleDateString('ko')}
                    {canResume && <span style={{ color: T.accent }}> · 이어보기</span>}
                  </div>
                </div>
                <button onClick={e => handleDelete(h.id, e)}
                  style={{ background: 'none', border: 'none', color: T.fgDim, cursor: 'pointer', fontSize: 18, padding: '2px 4px' }}>×</button>
              </div>
            )
          })}
        </div>
      ) })()}
      </div>
      )}
    </div>
  )
}

