import { useState } from 'react'
import { T } from '../lib/core.js'

const STATUS_LABEL = {
  pending: '대기',
  formatting: '포맷 중',
  formatted: '포맷 완료',
  translating: '번역 중',
  done: '완료',
  error_format: '포맷 실패',
  error_translate: '번역 실패',
}

const STATUS_COLOR = {
  pending: T.fgDim,
  formatting: T.warn,
  formatted: T.fgMuted,
  translating: T.warn,
  done: T.good,
  error_format: T.err,
  error_translate: T.err,
}

export default function SceneCard({ scene, index, onRetry, onReprocess, expanded, onToggle }) {
  const isError = scene.status.startsWith('error')
  const isDone = scene.status === 'done'
  const isActive = scene.status === 'formatting' || scene.status === 'translating'

  const totalTokens = scene.tokens
    ? (scene.tokens.format_in || 0) + (scene.tokens.format_out || 0) +
      (scene.tokens.translate_in || 0) + (scene.tokens.translate_out || 0)
    : 0

  return (
    <div style={{
      background: T.bgCard, borderRadius: 8,
      border: `1px solid ${isError ? T.err + '44' : isActive ? T.accent + '44' : T.rule}`,
      marginBottom: 6, overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}
      >
        <span style={{ color: T.fgDim, fontSize: 12, minWidth: 28 }}>#{index + 1}</span>

        <span style={{ flex: 1, color: T.fg, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {scene.heading || scene.raw.split('\n')[0].trim().slice(0, 80) || '(무제)'}
        </span>

        <span style={{ color: STATUS_COLOR[scene.status], fontSize: 12, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
          {isActive && <Spinner />}
          {STATUS_LABEL[scene.status]}
        </span>

        {totalTokens > 0 && (
          <span style={{ color: T.fgDim, fontSize: 11 }}>{totalTokens.toLocaleString()}tok</span>
        )}

        {isError && (
          <button onClick={e => { e.stopPropagation(); onRetry(scene.id) }}
            style={btnStyle(T.err)}>재시도</button>
        )}
        {isDone && (
          <button onClick={e => { e.stopPropagation(); onReprocess(scene.id) }}
            style={btnStyle(T.fgDim)}>재처리</button>
        )}
      </div>

      {/* 완료 씬: 번역 미리보기 (접힌 상태에서도 표시) */}
      {!expanded && isDone && scene.translated && (
        <div onClick={onToggle} style={{
          padding: '0 14px 10px 50px', cursor: 'pointer',
          color: T.fgMuted, fontSize: 12.5, lineHeight: 1.7,
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>
          {scene.translated.replace(/^#[^\n]+\n+/, '').trim()}
        </div>
      )}

      {expanded && (
        <div style={{ borderTop: `1px solid ${T.rule}`, padding: 14 }}>
          <SceneDetail scene={scene} />
        </div>
      )}
    </div>
  )
}

function SceneDetail({ scene }) {
  const tabs = [
    { key: 'raw', label: '원문', text: scene.raw },
    scene.formatted && { key: 'formatted', label: '포맷', text: scene.formatted },
    scene.translated && { key: 'translated', label: '번역', text: scene.translated },
  ].filter(Boolean)

  const [tab, setTab] = useState(tabs[tabs.length - 1]?.key || 'raw')
  const current = tabs.find(t => t.key === tab) || tabs[0]

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '3px 10px', borderRadius: 4, border: 'none',
              background: tab === t.key ? T.accent : T.chip,
              color: tab === t.key ? T.accentFg : T.fgMuted,
              fontSize: 12, cursor: 'pointer',
            }}>{t.label}</button>
        ))}
      </div>
      <pre style={{
        fontFamily: 'monospace', fontSize: 12, color: T.fg,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: 320, overflowY: 'auto', lineHeight: 1.7,
      }}>{current?.text || ''}</pre>
      {scene.error && (
        <div style={{ color: T.err, fontSize: 12, marginTop: 8 }}>{scene.error}</div>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', lineHeight: 1 }}>⟳</span>
  )
}

function btnStyle(color) {
  return {
    padding: '3px 8px', borderRadius: 4, border: `1px solid ${color}`,
    background: 'none', color, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
  }
}
