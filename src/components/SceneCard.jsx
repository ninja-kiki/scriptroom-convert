import { useState } from 'react'
import { T, classifyError } from '../lib/core.js'
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

export default function SceneCard({ scene, sceneNo, onRetry, onReprocess, expanded, onToggle, viewMode, onViewChange }) {
  // 상태색(고정 의미 — 액센트 회전과 무관): 완료=초록(good) · 진행중=노랑(warn) · 문제=빨강(err) · 그 외=중립
  const STATUS_COLOR = {
    pending: T.fgDim,
    formatting: T.warn,
    formatted: T.fgMuted,
    translating: T.warn,
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
    <div data-scene-id={scene.id} style={{
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

        <span style={{
          flex: 1, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          color: scene.heading ? T.fg : T.fgDim,
          fontStyle: scene.heading ? 'normal' : 'italic',
        }}>
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
          const aligned = scene.smiMatches.filter(m => m.aligned).length
          // 공식 자막과 확신 정렬된 대사 수 (참고 정보 — 교체 아님)
          return (
            <span title={`공식 자막과 정렬된 대사 ${aligned}/${total} (${Math.round((aligned / total) * 100)}%)`}
              style={{ fontSize: 11, color: T.fgDim, whiteSpace: 'nowrap' }}>
              자막정렬 {aligned}/{total}
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
          <SceneDetail scene={scene} viewMode={viewMode} onViewChange={onViewChange} />
        </div>
      )}
    </div>
  )
}

function SceneDetail({ scene, viewMode, onViewChange }) {
  // 테마(live T) 반영 — 모듈 레벨이 아니라 렌더 시점에 정의
  const preStyle = {
    fontFamily: 'monospace', fontSize: 12, color: T.fg,
    lineHeight: 1.7, margin: 0,
  }
  const tabs = [
    { key: 'raw', label: '원문', text: scene.raw },
    scene.formatted && { key: 'formatted', label: '포맷', text: scene.formatted },
    scene.translated && { key: 'translated', label: '번역', text: scene.translated },
  ].filter(Boolean)

  // viewMode가 외부에서 제어되면(인라인 리더 ←→) 그걸 쓰고, 없는 뷰면 가용한 것 중 최선으로 폴백
  const [localTab, setLocalTab] = useState(tabs[tabs.length - 1]?.key || 'raw')
  const controlled = viewMode != null
  const wanted = controlled ? viewMode : localTab
  const current = tabs.find(t => t.key === wanted) || tabs[tabs.length - 1] || tabs[0]
  const setTab = (k) => { if (controlled) onViewChange?.(k); else setLocalTab(k) }
  const tab = current?.key

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
        <span style={{ marginLeft: 'auto', alignSelf: 'center', color: T.fgDim, fontSize: 10.5 }}>←→ 포맷·번역 · ↑↓ 스크롤/씬 이동</span>
      </div>
      {/* 고정 높이 스크롤 박스 — 포맷·번역 모두 같은 크기로 열려 방향키 읽기에 일관됨 */}
      <div data-scene-scroll style={{ height: 300, overflowY: 'auto' }}>
        {tab === 'translated'
          ? <AnnotatedTranslation text={scene.translated || ''} />
          : <pre style={{ ...preStyle, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{current?.text || ''}</pre>
        }
      </div>
      {scene.status?.startsWith('error') && scene.error && (() => {   // 성공(done)한 씬엔 옛 에러 안 띄움 — 실패 상태일 때만
        const e = classifyError(scene.error)
        return (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: T.err, fontSize: 12.5, fontWeight: 600 }}>{e.label}</div>
            {e.hint && <div style={{ color: T.fgMuted, fontSize: 11.5, marginTop: 2 }}>{e.hint}</div>}
            {e.raw && <div style={{ color: T.fgDim, fontSize: 10.5, marginTop: 3, fontFamily: 'monospace', wordBreak: 'break-word' }}>{e.raw.slice(0, 120)}</div>}
          </div>
        )
      })()}
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
