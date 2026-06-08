import { useState } from 'react'
import { T } from '../lib/core.js'
import AnnotatedTranslation from './AnnotatedTranslation.jsx'

const STATUS_LABEL = {
  pending: '대기',
  formatting: '포맷 중',
  formatted: '포맷 완료',
  translating: '번역 중',
  done: '완료',
  error_format: '포맷 실패',
  error_translate: '번역 실패',
}

export default function SceneCard({ scene, sceneNo, onRetry, onReprocess, expanded, onToggle }) {
  // 테마(live T) 따라가도록 컴포넌트 안에서 정의 + 의미색(파랑=포맷, 빨강=번역)
  const preStyle = {
    fontFamily: 'monospace', fontSize: 12, color: T.fg,
    maxHeight: 320, overflowY: 'auto', lineHeight: 1.7, margin: 0,
  }
  const STATUS_COLOR = {
    pending: T.fgDim,
    formatting: T.fmt,
    formatted: T.fmt,
    translating: T.trans,
    done: T.good,
    error_format: T.err,
    error_translate: T.err,
  }
  const isError = scene.status.startsWith('error')
  const isDone = scene.status === 'done'
  const isActive = scene.status === 'formatting' || scene.status === 'translating'
  // 표시 제목: 헤딩 우선, 없으면 첫 의미 있는 줄(페이지마커 제외)
  const titleLine = scene.heading ||
    (scene.formatted || scene.raw).split('\n').find(l => l.trim() && !/^(#|Page\s+\d)/i.test(l.trim()))?.trim().slice(0, 80) ||
    '(이어지는 내용)'

  const totalTokens = scene.tokens
    ? (scene.tokens.format_in || 0) + (scene.tokens.format_out || 0) +
      (scene.tokens.translate_in || 0) + (scene.tokens.translate_out || 0)
    : 0

  return (
    <div style={{
      background: T.bgCard, borderRadius: 3,
      marginBottom: 5, overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}
      >
        <span style={{ color: T.fgDim, fontSize: 12, minWidth: 28 }}>
          {sceneNo != null ? `#${sceneNo}` : <span style={{ color: T.fgDim }}>↳</span>}
        </span>

        <span style={{ flex: 1, color: T.fg, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {titleLine}
        </span>

        {totalTokens > 0 && (
          <span style={{ color: T.fgDim, fontSize: 11 }}>{totalTokens.toLocaleString()}tok</span>
        )}

        <span style={{ color: STATUS_COLOR[scene.status], fontSize: 12, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
          {isActive && <Spinner />}
          {STATUS_LABEL[scene.status]}
        </span>

        {isDone && scene.smiMatches?.length > 0 && (() => {
          const total = scene.smiMatches.length
          const matched = scene.smiMatches.filter(m => m.replaced).length
          const rate = matched / total
          const color = rate >= 0.6 ? T.good : rate >= 0.3 ? T.warn : T.err
          const low = rate < 0.3
          return (
            <span title={`자막과 일치한 대사 ${matched}/${total} (${Math.round(rate * 100)}%)${low ? ' · 각본과 영화 자막 차이가 커요 — 번역이 자막에 덜 맞춰졌을 수 있어요' : ''}`}
              style={{ fontSize: 11, color, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 2 }}>
              {low && '⚠'}자막 {matched}/{total}
            </span>
          )
        })()}

        {isError && (
          <button onClick={e => { e.stopPropagation(); onRetry(scene.id) }}
            title="재시도" aria-label="재시도" style={iconBtn(T.fgMuted)}><RetryIcon /></button>
        )}
        {isDone && (
          <button onClick={e => { e.stopPropagation(); onReprocess(scene.id) }}
            title="재처리" aria-label="재처리" style={iconBtn(T.fgDim)}><RetryIcon /></button>
        )}
      </div>


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
      {tab === 'translated'
        ? <AnnotatedTranslation text={scene.translated || ''} smiMatches={scene.smiMatches} />
        : <pre style={{ ...preStyle, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{current?.text || ''}</pre>
      }
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

function iconBtn(color) {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 26, height: 26, padding: 0, borderRadius: 3, border: 'none',
    background: 'transparent', color, cursor: 'pointer', flexShrink: 0,
  }
}

function RetryIcon() {
  // refresh-cw (lucide) — 화살촉이 또렷한 재시도 아이콘
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}
