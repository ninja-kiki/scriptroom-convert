import { useRef, useState } from 'react'
import { T, loadHistory, deleteHistory, fmtDuration, fmtTokens } from '../lib/core.js'

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

export default function UploadStep({ onLoad, onRestore }) {
  const scriptRef = useRef()
  const smiRef = useRef()
  const [scriptFile, setScriptFile] = useState(null)
  const [smiFile, setSmiFile] = useState(null)
  const [dragOverScript, setDragOverScript] = useState(false)
  const [dragOverSmi, setDragOverSmi] = useState(false)
  const [smiWarning, setSmiWarning] = useState(false)
  const [history, setHistory] = useState(() => loadHistory())
  const [loading, setLoading] = useState(false)

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

  function handleSmiFile(file) {
    if (!file || !SMI_EXTS.includes(getExt(file))) return
    setSmiFile(file)
    setSmiWarning(false)
  }

  function handleScriptDrop(e) {
    e.preventDefault()
    setDragOverScript(false)
    handleScriptFile(e.dataTransfer.files[0])
  }

  function handleSmiDrop(e) {
    e.preventDefault()
    setDragOverSmi(false)
    handleSmiFile(e.dataTransfer.files[0])
  }

  function handleDelete(id, e) {
    e.stopPropagation()
    const entry = history.find(h => h.id === id)
    if (!window.confirm(`"${entry?.title}" 기록을 삭제할까요?`)) return
    deleteHistory(id)
    setHistory(loadHistory())
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

      {/* 각본 드롭존 */}
      <div
        onClick={() => !scriptFile && scriptRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOverScript(true) }}
        onDragLeave={() => setDragOverScript(false)}
        onDrop={handleScriptDrop}
        style={{
          border: `2px dashed ${dragOverScript ? T.accent : scriptFile ? T.accent + '66' : T.rule}`,
          borderRadius: 12, padding: scriptFile ? '16px 18px' : '36px 24px',
          textAlign: 'center', cursor: scriptFile ? 'default' : 'pointer',
          background: dragOverScript ? '#1e1a13' : T.bgCard,
          transition: 'all .15s', marginBottom: 8,
        }}
      >
        {scriptFile ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ color: T.accent, fontWeight: 600, fontSize: 14 }}>{scriptFile.name}</div>
              <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                {(scriptFile.size / 1024 / 1024).toFixed(1)} MB · {getExt(scriptFile).toUpperCase()}
              </div>
            </div>
            <button onClick={e => { e.stopPropagation(); setScriptFile(null); setSmiWarning(false) }}
              style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>
        ) : (
          <>
            <div style={{ color: T.fgMuted, fontSize: 28, marginBottom: 10, lineHeight: 1 }}>⬇</div>
            <div style={{ color: T.fg, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>각본 파일 드롭 또는 클릭</div>
            <div style={{ color: T.fgDim, fontSize: 12 }}>PDF · TXT · RTF · FDX · Fountain</div>
          </>
        )}
        <input ref={scriptRef} type="file" accept=".pdf,.txt,.rtf,.fdx,.fountain" hidden
          onChange={e => handleScriptFile(e.target.files[0])} />
      </div>

      {/* SMI 드롭존 */}
      <div
        onClick={() => smiRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOverSmi(true) }}
        onDragLeave={() => setDragOverSmi(false)}
        onDrop={handleSmiDrop}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          border: `1.5px dashed ${dragOverSmi ? T.accent : smiFile ? T.good + '66' : T.rule}`,
          borderRadius: 10, padding: '11px 14px',
          background: dragOverSmi ? '#0d1a12' : T.bgCard,
          cursor: 'pointer', marginBottom: 16, transition: 'all .15s',
        }}
      >
        <span style={{ color: T.fgDim, fontSize: 13, flexShrink: 0 }}>자막</span>
        <span style={{ color: smiFile ? T.good : T.fgDim, fontSize: 13, flex: 1 }}>
          {smiFile ? smiFile.name : 'SMI / SRT 드롭 또는 클릭 (선택)'}
        </span>
        {smiFile ? (
          <button onClick={e => { e.stopPropagation(); setSmiFile(null); setSmiWarning(false) }}
            style={{ background: 'none', border: 'none', color: T.fgDim, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        ) : (
          <span style={{ color: T.fgDim, fontSize: 11 }}>선택사항</span>
        )}
        <input ref={smiRef} type="file" accept=".smi,.srt" hidden onChange={e => handleSmiFile(e.target.files[0] || null)} />
      </div>

      {/* 경고: SMI 없음 */}
      {smiWarning && (
        <div style={{
          marginBottom: 12, padding: '12px 14px', borderRadius: 10,
          background: T.bgCard, border: `1px solid ${T.accent}55`,
        }}>
          <div style={{ color: T.accent, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>SMI 자막 없이 진행할까요?</div>
          <div style={{ color: T.fgMuted, fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
            자막 파일이 있으면 번역 품질이 높아집니다.<br />
            <span style={{ color: T.fgDim }}>opensubtitles.org · subscene.com · viki.com 등에서 구할 수 있습니다.</span>
          </div>
          <button onClick={handleLoad} style={{
            padding: '7px 14px', borderRadius: 7, border: `1px solid ${T.accent}66`,
            background: 'none', color: T.accent, fontSize: 13, cursor: 'pointer', fontWeight: 500,
          }}>
            {loading ? '불러오는 중...' : '자막 없이 시작'}
          </button>
        </div>
      )}

      <button
        disabled={!scriptFile || loading}
        onClick={handleLoad}
        style={{
          width: '100%', padding: '12px', borderRadius: 10, border: 'none',
          background: (!scriptFile || loading) ? T.chip : T.accent,
          color: (!scriptFile || loading) ? T.fgDim : T.accentFg,
          fontWeight: 700, fontSize: 15, cursor: !scriptFile || loading ? 'default' : 'pointer',
          marginBottom: 28,
        }}
      >
        {loading ? '불러오는 중...' : '불러오기'}
      </button>

      {/* 이어하기 + 작업 기록 */}
      {(currentSession || history.length > 0) && (
        <div>
          <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 8 }}>작업 기록</div>

          {currentSession && (
            <div onClick={() => onRestore(currentSession)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '11px 14px', background: T.bgCard,
              border: `1px solid ${T.accent}44`, borderRadius: 10,
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

          {history.map(h => (
            <div key={h.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', background: T.bgCard,
              border: `1px solid ${T.rule}`, borderRadius: 10, marginBottom: 6,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.fg, fontWeight: 500, fontSize: 14 }}>{h.title}</div>
                <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                  {h.scenes}씬 · {fmtDuration(h.duration)} · {fmtTokens(h.tokens)}tok
                  {h.costUsd != null && ` · $${h.costUsd.toFixed(2)}`}
                  {' · '}{new Date(h.id).toLocaleDateString('ko')}
                </div>
              </div>
              <button onClick={e => handleDelete(h.id, e)}
                style={{ background: 'none', border: 'none', color: T.fgDim, cursor: 'pointer', fontSize: 18, padding: '2px 4px' }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
