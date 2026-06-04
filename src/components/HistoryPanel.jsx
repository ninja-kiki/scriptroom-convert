import { T, loadHistory, fmtDuration, fmtTokens } from '../lib/core.js'

const SESSION_KEY = 'convert_session'

export default function HistoryPanel({ onClose, onRestore }) {
  const history = loadHistory()

  function handleRestoreCurrent() {
    // 현재 세션이 있으면 복원
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
      if (session) onRestore(session)
    } catch {}
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
            {history.map(h => (
              <div key={h.id} style={{
                padding: '12px 0', borderBottom: `1px solid ${T.rule}`,
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, alignItems: 'start',
              }}>
                <div>
                  <div style={{ color: T.fg, fontWeight: 600, fontSize: 14 }}>{h.title}</div>
                  <div style={{ color: T.fgMuted, fontSize: 12, marginTop: 2 }}>
                    {h.scenes}씬 · {fmtDuration(h.duration)} · {fmtTokens(h.tokens)} tok
                    {h.costUsd != null && ` · $${h.costUsd.toFixed(2)}`}
                  </div>
                </div>
                <div style={{ color: T.fgDim, fontSize: 12, textAlign: 'right' }}>
                  {new Date(h.id).toLocaleDateString('ko')}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 현재 세션 복원 */}
        {localStorage.getItem(SESSION_KEY) && (
          <button onClick={handleRestoreCurrent}
            style={{
              marginTop: 12, padding: '10px', borderRadius: 8,
              background: T.accent, border: 'none',
              color: T.accentFg, fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}>
            마지막 작업 이어보기
          </button>
        )}
      </div>
    </div>
  )
}
