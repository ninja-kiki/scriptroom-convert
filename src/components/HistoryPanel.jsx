import { useState } from 'react'
import { T, loadHistory, deleteHistory, fmtDuration } from '../lib/core.js'

export default function HistoryPanel({ onClose, onRestore }) {
  const [history, setHistory] = useState(() => loadHistory())

  function handleDelete(e, id) {
    e.stopPropagation()
    deleteHistory(id)
    setHistory(loadHistory())
  }

  function handleRestore(h) {
    if (!h.sceneData) return
    onRestore({ title: h.title, scenes: h.sceneData, startTime: h.startTime, jobId: h.id, smiLines: null })
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000a',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      zIndex: 100,
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 600,
          background: T.bgCard, borderRadius: '16px 16px 0 0',
          padding: 20, maxHeight: '75vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ color: T.fg, fontWeight: 700 }}>작업 기록</h3>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.fgMuted, fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        {history.length === 0 ? (
          <p style={{ color: T.fgMuted, fontSize: 14 }}>기록 없음</p>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {history.map(h => {
              const total = h.sceneCount ?? (h.sceneData ? h.sceneData.length : (h.scenes || 0))
              const doneCount = h.doneCount ?? (h.sceneData ? h.sceneData.filter(s => s.status === 'done').length : 0)
              const isComplete = total > 0 && doneCount >= total
              const hasData = !!h.sceneData && total > 0

              return (
                <div key={h.id} style={{
                  padding: '12px 0', borderBottom: `1px solid ${T.rule}`,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  {hasData && !isComplete && (
                    <button onClick={() => handleRestore(h)} style={{
                      background: 'none', border: 'none', color: T.accent,
                      fontSize: 18, cursor: 'pointer', padding: '0 4px', flexShrink: 0,
                    }}>▶</button>
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: T.fg, fontWeight: 600, fontSize: 14 }}>{h.title}</div>
                    <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                      {doneCount !== null ? `${doneCount}/${total}씬 완료` : `${total}씬`}
                      {h.duration ? ` · ${fmtDuration(h.duration)}` : ''}
                      {' · '}{new Date(h.id).toLocaleDateString('ko')}
                    </div>
                    {hasData && !isComplete && (
                      <button onClick={() => handleRestore(h)} style={{
                        marginTop: 4, background: 'none', border: 'none',
                        color: T.accent, fontSize: 12, cursor: 'pointer', padding: 0,
                      }}>이어보기</button>
                    )}
                  </div>

                  <button onClick={e => handleDelete(e, h.id)}
                    style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 18, cursor: 'pointer' }}>×</button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
