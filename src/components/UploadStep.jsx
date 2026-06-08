import { useRef, useState } from 'react'
import { T, loadHistory, deleteHistory, fmtDuration, fmtTokens, loadGuidelines, loadSettings } from '../lib/core.js'
import { decodeSubtitle, parseSubtitleLines, subtitleInfo } from '../lib/smi.js'
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

export default function UploadStep({ onLoad, onRestore, onRevise }) {
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
  const [loading, setLoading] = useState(false)
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
    <div style={{ padding: '28px 20px', maxWidth: 480, margin: '0 auto' }}>

      {/* 탭 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
        {[{ id: 'convert', label: '변환' }, { id: 'revise', label: '수정' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '7px 18px', borderRadius: 3, border: 'none', cursor: 'pointer',
            background: tab === t.id ? T.accent : T.chip,
            color: tab === t.id ? T.accentFg : T.fgMuted,
            fontWeight: 700, fontSize: 14,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'revise' && (
        <div>
          {/* 리더 수정요청(JSON) → AI 수정 → 오버레이 */}
          <div style={{ marginBottom: 18, padding: 14, borderRadius: 3, border: `1px solid ${T.rule}`, background: T.bgCard }}>
            <div style={{ color: T.fg, fontWeight: 600, fontSize: 13, marginBottom: 4 }}>리더 수정요청 처리 <span style={{ color: T.fgDim, fontWeight: 400 }}>(오류 마크 → AI 수정)</span></div>
            {!fixReq ? (
              <>
                <div style={{ color: T.fgDim, fontSize: 12, marginBottom: 10 }}>리더에서 내보낸 <code>_수정요청.json</code>을 올리면 Max로 고쳐 <code>_수정.json</code>(오버레이)을 만들어요. 원본은 안 건드림.</div>
                <button onClick={() => fixReqRef.current.click()} style={{ padding: '8px 14px', borderRadius: 3, border: `1px solid ${T.rule}`, background: T.chip, color: T.fg, fontSize: 13, cursor: 'pointer' }}>수정요청 JSON 불러오기</button>
              </>
            ) : (
              <>
                <div style={{ color: T.fgMuted, fontSize: 12, marginBottom: 10 }}>{fixReq.title || fixReq.id} · 오류 마크 {fixReq.items.length}건</div>
                {fixProgress && (
                  <div style={{ height: 4, background: T.rule, borderRadius: 2, marginBottom: 8 }}>
                    <div style={{ height: '100%', borderRadius: 2, background: T.accent, width: `${(fixProgress.done / fixProgress.total) * 100}%`, transition: 'width .3s' }} />
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={runFixReq} disabled={fixRunning} style={{ padding: '8px 14px', borderRadius: 3, border: 'none', background: fixRunning ? T.chip : T.accent, color: fixRunning ? T.fgDim : T.accentFg, fontSize: 13, fontWeight: 700, cursor: fixRunning ? 'default' : 'pointer' }}>
                    {fixRunning ? `수정 중 ${fixProgress?.done || 0}/${fixProgress?.total || 0}` : 'AI 수정 → 오버레이 다운로드'}
                  </button>
                  {!fixRunning && <button onClick={() => setFixReq(null)} style={{ padding: '8px 12px', borderRadius: 3, border: `1px solid ${T.rule}`, background: 'none', color: T.fgMuted, fontSize: 13, cursor: 'pointer' }}>취소</button>}
                </div>
              </>
            )}
            <input ref={fixReqRef} type="file" accept=".json" hidden onChange={e => { handleFixReqSelect(e.target.files[0]); e.target.value = ''; }} />
          </div>

          {/* 파일 드롭존 */}
          <div
            onClick={() => !reviseFile && reviseRef.current.click()}
            onDragOver={e => { e.preventDefault(); setDragOverRevise(true) }}
            onDragLeave={() => setDragOverRevise(false)}
            onDrop={e => { e.preventDefault(); setDragOverRevise(false); handleReviseFileSelect(e.dataTransfer.files[0]) }}
            style={{
              border: `2px dashed ${dragOverRevise ? T.accent : reviseFile ? T.accent + '66' : T.rule}`,
              borderRadius: 3, padding: reviseFile ? '16px 18px' : '36px 24px',
              textAlign: 'center', cursor: reviseFile ? 'default' : 'pointer',
              background: dragOverRevise ? '#EBDFC4' : T.bgCard,
              transition: 'all .15s', marginBottom: 16,
            }}
          >
            {reviseFile ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ color: T.accent, fontWeight: 600, fontSize: 14 }}>{reviseFile.name}</div>
                  {reviseFileType && (
                    <div style={{ color: T.fgMuted, fontSize: 12, fontWeight: 600, marginTop: 2 }}>
                      {reviseFileType === 'translated' ? '번역본으로 인식됨' : '포맷본으로 인식됨'}
                    </div>
                  )}
                </div>
                <button onClick={e => { e.stopPropagation(); setReviseFile(null); setReviseIssues(null); setReviseDone(false); setLlmChunks([]); setFeedbackFile(null); setFeedbackItems(null) }}
                  style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 20, cursor: 'pointer' }}>×</button>
              </div>
            ) : (
              <>
                <div style={{ color: T.fgMuted, fontSize: 28, marginBottom: 10 }}>⬇</div>
                <div style={{ color: T.fg, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>formatted.txt 또는 translated.txt 드롭</div>
                <div style={{ color: T.fgDim, fontSize: 12 }}>파일 타입 자동 인식 · 규칙 수정 0토큰</div>
              </>
            )}
            <input ref={reviseRef} type="file" accept=".txt" hidden onChange={e => handleReviseFileSelect(e.target.files[0])} />
          </div>

          {/* 검수 피드백 파일 (선택) */}
          {reviseFile && (
            <div
              onClick={() => !feedbackFile && feedbackRef.current.click()}
              onDragOver={e => { e.preventDefault(); setDragOverFeedback(true) }}
              onDragLeave={() => setDragOverFeedback(false)}
              onDrop={e => { e.preventDefault(); setDragOverFeedback(false); handleFeedbackSelect(e.dataTransfer.files[0]) }}
              style={{
                border: `2px dashed ${dragOverFeedback ? T.accent : feedbackFile ? T.good + '66' : T.rule}`,
                borderRadius: 3, padding: feedbackFile ? '14px 16px' : '20px 24px',
                textAlign: 'center', cursor: feedbackFile ? 'default' : 'pointer',
                background: dragOverFeedback ? '#DDE8DE' : T.bgCard, marginBottom: 16,
              }}
            >
              {feedbackFile ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ color: T.good, fontWeight: 600, fontSize: 13 }}>{feedbackFile.name}</div>
                    <div style={{ color: T.fgDim, fontSize: 12, marginTop: 2 }}>
                      피드백 {feedbackItems.length}건 · 직접수정 {feedbackClass.direct.length} (0토큰) · 해석필요 {feedbackClass.llm.length} <span style={{ color: T.fgDim }}>(LLM 예정)</span>
                    </div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); setFeedbackFile(null); setFeedbackItems(null) }}
                    style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 20, cursor: 'pointer' }}>×</button>
                </div>
              ) : (
                <>
                  <div style={{ color: T.fg, fontWeight: 600, fontSize: 13, marginBottom: 3 }}>검수 피드백 (_feedback.txt) 드롭 — 선택</div>
                  <div style={{ color: T.fgDim, fontSize: 12 }}>모바일에서 직접 고친 건 그대로 반영(0토큰)</div>
                </>
              )}
              <input ref={feedbackRef} type="file" accept=".txt" hidden onChange={e => handleFeedbackSelect(e.target.files[0])} />
            </div>
          )}

          {/* 이슈 목록 */}
          {reviseIssues !== null && (
            <div style={{ marginBottom: 16 }}>
              {reviseIssues.length === 0 ? (
                <div style={{ color: T.good, fontSize: 14, padding: '10px 0' }}>수정할 항목이 없습니다 ✓</div>
              ) : (
                <>
                  <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 8 }}>감지된 항목</div>
                  {reviseIssues.map(issue => (
                    <div key={issue.id} onClick={() => toggleReviseSelect(issue.id)} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '11px 14px', marginBottom: 6,
                      background: T.bgCard, border: `1px solid ${reviseSelected.includes(issue.id) ? T.accent + '66' : T.rule}`,
                      borderRadius: 3, cursor: 'pointer',
                    }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                        background: reviseSelected.includes(issue.id) ? T.accent : 'none',
                        border: `2px solid ${reviseSelected.includes(issue.id) ? T.accent : T.fgDim}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {reviseSelected.includes(issue.id) && <span style={{ color: T.accentFg, fontSize: 11, fontWeight: 700 }}>✓</span>}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: T.fg, fontSize: 13 }}>{issue.label}</div>
                      </div>
                      <div style={{ color: T.fgDim, fontSize: 12 }}>{issue.count}건</div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* 사용자 지시사항 (LLM) */}
          {reviseIssues !== null && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 8 }}>
                추가 수정 지시사항 <span style={{ color: T.fgDim, fontWeight: 400, textTransform: 'none' }}>(선택 · LLM 사용)</span>
              </div>
              <textarea
                value={userInstruction}
                onChange={e => handleInstructionChange(e.target.value)}
                placeholder={'예: 대사 다음 지문 사이에 빈 줄이 없으면 추가해줘\n예: CREDIT 표기가 잘못된 경우 [CREDIT:]로 수정해줘'}
                style={{
                  width: '100%', minHeight: 80, resize: 'vertical',
                  background: T.bgInput, border: `1px solid ${T.rule}`,
                  borderRadius: 3, color: T.fg, fontSize: 13,
                  padding: 12, fontFamily: 'inherit', lineHeight: 1.5, outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {llmChunks.length > 0 && (
                <div style={{ color: T.fgDim, fontSize: 12, marginTop: 6 }}>
                  LLM 처리 예상: {llmChunks.length}개 구간 · 약 {Math.round(estimateTokens(llmChunks) / 1000 * 10) / 10}k 토큰
                </div>
              )}
            </div>
          )}

          {/* 진행 상태 */}
          {llmProgress && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ height: 4, background: T.rule, borderRadius: 2, marginBottom: 6 }}>
                <div style={{ height: '100%', borderRadius: 2, background: T.accent, width: `${(llmProgress.done / llmProgress.total) * 100}%`, transition: 'width .3s' }} />
              </div>
              <div style={{ color: T.fgMuted, fontSize: 12 }}>LLM 처리 중 {llmProgress.done}/{llmProgress.total}</div>
            </div>
          )}

          {/* 수정 적용 버튼 */}
          {reviseIssues !== null && (reviseIssues.length > 0 || llmChunks.length > 0 || feedbackItems?.length > 0) && (
            <button
              onClick={handleReviseApply}
              disabled={reviseRunning || (reviseSelected.length === 0 && llmChunks.length === 0 && !(feedbackItems?.length > 0))}
              style={{
                width: '100%', padding: '13px', borderRadius: 3, border: 'none',
                background: reviseDone ? T.good : reviseRunning ? T.chip : T.accent,
                color: reviseRunning ? T.fgDim : T.accentFg,
                fontWeight: 700, fontSize: 15, cursor: reviseRunning ? 'default' : 'pointer',
              }}
            >
              {reviseDone ? '다운로드 완료 ✓' : reviseRunning ? '처리 중...' : `수정 적용 후 다운로드`}
            </button>
          )}
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
        style={{
          border: `2px dashed ${dragOverScript ? T.accent : scriptFile ? T.accent + '66' : T.rule}`,
          borderRadius: 3, padding: scriptFile ? '14px 16px' : '36px 24px',
          textAlign: 'center', cursor: scriptFile ? 'default' : 'pointer',
          background: dragOverScript ? '#EBDFC4' : T.bgCard,
          transition: 'all .15s', marginBottom: 16,
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
            {/* 바우하우스 3원색 트리오 — 세 조각이 모여 한 편이 된다는 위트 */}
            <svg width="92" height="34" viewBox="0 0 92 34" aria-hidden style={{ display: 'block', margin: '0 auto 16px' }}>
              <rect x="3" y="3" width="28" height="28" fill={T.trans} />
              <circle cx="46" cy="17" r="15" fill={T.warn} />
              <path d="M75 2l16 30H59z" fill={T.fmt} />
            </svg>
            <div style={{ color: T.fg, fontWeight: 700, fontSize: 16, letterSpacing: '-.2px', marginBottom: 6 }}>각본 자막을 올리세요</div>
            <div style={{ color: T.fgDim, fontSize: 12.5, lineHeight: 1.5 }}>
              <span style={{ color: T.fgMuted, fontWeight: 600 }}>각본</span> PDF · TXT · RTF · FDX · Fountain
              <span style={{ margin: '0 7px', color: T.rule }}>|</span>
              <span style={{ color: T.fgMuted, fontWeight: 600 }}>자막</span> SMI · SRT <span style={{ color: T.fgDim }}>(선택)</span>
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

      {/* 이어하기 + 작업 기록 */}
      {(currentSession || history.length > 0) && (
        <div>
          <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 8 }}>작업 기록</div>

          {currentSession && (
            <div onClick={() => onRestore(currentSession)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '11px 14px', background: T.bgCard,
              border: `1px solid ${T.accent}44`, borderRadius: 3,
              cursor: 'pointer', marginBottom: 6,
            }}>
              <span style={{ color: T.accent, fontSize: 15 }}>▶</span>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.accent, fontWeight: 600, fontSize: 14 }}>{currentSession.title}</div>
                <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                  {currentSession.scenes?.filter(s => s.status === 'done').length}/{currentSession.scenes?.length}씬 완료 · 이어보기
                </div>
              </div>
            </div>
          )}

          {history.map(h => {
            const doneCount = h.sceneData ? h.sceneData.filter(s => s.status === 'done').length : 0
            const total = h.sceneData ? h.sceneData.length : (h.sceneCount || 0)
            const isComplete = total > 0 && doneCount === total
            const canResume = !!h.sceneData && total > 0 && !isComplete

            return (
              <div key={h.id} onClick={canResume ? () => onRestore({ title: h.title, scenes: h.sceneData, startTime: h.startTime, jobId: h.id, smiLines: null }) : undefined} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: T.bgCard,
                border: `1px solid ${canResume ? T.accent + '44' : T.rule}`, borderRadius: 3, marginBottom: 6,
                cursor: canResume ? 'pointer' : 'default',
              }}>
                {canResume && <span style={{ color: T.accent, fontSize: 15 }}>▶</span>}
                <div style={{ flex: 1 }}>
                  <div style={{ color: canResume ? T.accent : T.fg, fontWeight: 500, fontSize: 14 }}>{h.title}</div>
                  <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                    {doneCount !== null ? `${doneCount}/${total}씬 완료` : `${total}씬`}
                    {h.duration ? ` · ${fmtDuration(h.duration)}` : ''}
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
      )}
      </div>
      )}
    </div>
  )
}

