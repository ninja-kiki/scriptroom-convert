import { useState } from 'react'
import { T, fmtDuration, fmtTokens, loadSettings } from '../lib/core.js'
import SceneCard from './SceneCard.jsx'

export default function ProcessPanel({ title, scenes, phase, startTime, isPaused, isRateLimited, onPause, onResume, onStop, onContinue, onRetry, onReprocess, onDownload, onReset }) {
  const [expandedId, setExpandedId] = useState(null)

  const total = scenes.length
  const doneCount = scenes.filter(s => s.status === 'done').length
  const errCount = scenes.filter(s => s.status.startsWith('error')).length
  const { totalIn, totalOut } = scenes.reduce((acc, s) => {
    if (!s.tokens) return acc
    return {
      totalIn: acc.totalIn + (s.tokens.format_in || 0) + (s.tokens.translate_in || 0),
      totalOut: acc.totalOut + (s.tokens.format_out || 0) + (s.tokens.translate_out || 0),
    }
  }, { totalIn: 0, totalOut: 0 })
  const totalTokens = totalIn + totalOut
  // claude-sonnet: $3/MTok input, $15/MTok output
  const costUsd = (totalIn * 3 + totalOut * 15) / 1_000_000
  const fmtCost = costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`

  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const isDone = doneCount === total && total > 0
  const hasIncomplete = phase === 'done' && scenes.some(s => s.status !== 'done')

  return (
    <div style={{ padding: '24px 16px', maxWidth: 640, margin: '0 auto' }}>
      {isRateLimited && (
        <div style={{
          background: T.warn + '22', border: `1px solid ${T.warn}`,
          borderRadius: 10, padding: '14px 18px', marginBottom: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <div style={{ color: T.warn, fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Claude 사용량 한도 초과</div>
            <div style={{ color: T.fgMuted, fontSize: 13 }}>잠시 후 한도가 풀리면 재개 버튼을 눌러주세요.</div>
          </div>
          <button onClick={onResume} style={{ ...ctrlBtn, color: T.warn, borderColor: T.warn, whiteSpace: 'nowrap' }}>재개</button>
        </div>
      )}
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
          <h2 style={{ color: T.fg, fontSize: 18, fontWeight: 700 }}>{title}</h2>
          <span style={{ color: T.fgMuted, fontSize: 13 }}>
            {doneCount}/{total} 씬
            {errCount > 0 && <span style={{ color: T.err }}> · {errCount}개 오류</span>}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ height: 4, background: T.rule, borderRadius: 2, marginBottom: 8 }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${pct}%`,
            background: errCount > 0 ? T.err : isDone ? T.good : T.accent,
            transition: 'width .3s',
          }} />
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: T.fgMuted }}>
          <span>{pct}%</span>
          {startTime && <span>{fmtDuration(Date.now() - startTime)}</span>}
          {totalTokens > 0 && <span>{fmtTokens(totalTokens)} tokens · {fmtCost}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {phase !== 'done' && !isPaused && <span style={{ color: T.fgMuted }}>{phase === 'formatting' ? '포맷 중...' : '번역 중...'}</span>}
            {phase !== 'done' && !isPaused && (
              <button onClick={onPause} style={ctrlBtn}>일시정지</button>
            )}
            {phase !== 'done' && isPaused && (
              <button onClick={onResume} style={{ ...ctrlBtn, color: T.good, borderColor: T.good }}>재개</button>
            )}
            {phase !== 'done' && (
              <button onClick={() => { if (window.confirm('작업을 중단할까요? 진행된 씬은 유지됩니다.')) onStop() }} style={{ ...ctrlBtn, color: T.err, borderColor: T.err }}>중단</button>
            )}
            {phase === 'done' && !hasIncomplete && <span style={{ color: T.fgMuted }}>완료</span>}
            {hasIncomplete && (
              <button onClick={onContinue} style={{ ...ctrlBtn, color: T.accent, borderColor: T.accent }}>이어하기</button>
            )}
          </span>
        </div>
      </div>

      {/* Download buttons */}
      {scenes.length > 0 && (() => {
        const settings = loadSettings()
        const fmtCount = scenes.filter(s => s.formatted).length
        const transCount = scenes.filter(s => s.translated).length
        return (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {fmtCount > 0 && (
              <button onClick={() => onDownload('formatted')} style={dlBtn}>
                formatted.txt {!isDone && `(${fmtCount}씬)`}
              </button>
            )}
            {transCount > 0 && (
              <button onClick={() => onDownload('translated')} style={dlBtn}>
                translated.txt {!isDone && `(${transCount}씬)`}
              </button>
            )}
            {settings.downloadMerged && fmtCount > 0 && transCount > 0 && (
              <button onClick={() => onDownload('merged')} style={dlBtn}>
                merged.txt
              </button>
            )}
          </div>
        )
      })()}

      {/* Retry all errors */}
      {errCount > 0 && phase === 'done' && (
        <button onClick={() => scenes.filter(s => s.status.startsWith('error')).forEach(s => onRetry(s.id))}
          style={{ ...dlBtn, background: T.err + '22', borderColor: T.err, color: T.err, marginBottom: 12 }}>
          실패 씬 전체 재시도 ({errCount})
        </button>
      )}

      {/* Scene list */}
      <div>
        {scenes.map((scene, i) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            index={i}
            onRetry={onRetry}
            onReprocess={onReprocess}
            expanded={expandedId === scene.id}
            onToggle={() => setExpandedId(expandedId === scene.id ? null : scene.id)}
          />
        ))}
      </div>

      {/* New job button */}
      {isDone && (
        <button onClick={onReset}
          style={{ ...dlBtn, width: '100%', marginTop: 16, textAlign: 'center' }}>
          + 새 작업
        </button>
      )}
    </div>
  )
}

const ctrlBtn = {
  padding: '3px 10px', borderRadius: 6,
  background: 'none', border: `1px solid ${T.rule}`,
  color: T.fgMuted, fontSize: 12, cursor: 'pointer',
}

const dlBtn = {
  flex: 1, padding: '10px 14px', borderRadius: 8,
  background: T.chip, border: `1px solid ${T.rule}`,
  color: T.fg, fontSize: 13, cursor: 'pointer', fontWeight: 500,
}
