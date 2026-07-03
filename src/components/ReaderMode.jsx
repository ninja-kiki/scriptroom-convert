import { useState, useEffect, useRef, useCallback } from 'react'
import { T, classifyError } from '../lib/core.js'
import AnnotatedTranslation from './AnnotatedTranslation.jsx'

const VIEWS = ['raw', 'formatted', 'translated']
const VIEW_LABEL = { raw: '원문', formatted: '포맷', translated: '번역' }

export default function ReaderMode({ scenes, initialIndex = 0, onClose }) {
  const [sceneIdx, setSceneIdx] = useState(initialIndex)
  const [viewMode, setViewMode] = useState('translated')
  const [jumpInput, setJumpInput] = useState('')
  const [checked, setChecked] = useState(() => new Set())
  const contentRef = useRef()
  const jumpRef = useRef()

  const [reviewOnly, setReviewOnly] = useState(false)
  const scene = scenes[sceneIdx]
  const total = scenes.length

  const reviewIdxs = []   // 자막 유사도 기반 검토 제거 (각본↔영화자막은 본디 다름)

  // 씬 이동 — 검토 모드면 검토 씬만 건너뜀
  const stepScene = useCallback((dir) => {
    const toBottom = dir < 0   // 위로 갈 땐 이전 씬 맨 아래부터
    if (reviewOnly && reviewIdxs.length) {
      const cands = dir > 0 ? reviewIdxs.filter(i => i > sceneIdx) : reviewIdxs.filter(i => i < sceneIdx).reverse()
      goScene(cands.length ? cands[0] : reviewIdxs[dir > 0 ? 0 : reviewIdxs.length - 1], toBottom)
    } else goScene(sceneIdx + dir, toBottom)
  }, [reviewOnly, reviewIdxs, sceneIdx])

  // 현재 뷰에서 보여줄 텍스트
  function getContent() {
    if (viewMode === 'translated' && scene.translated) return { text: scene.translated }
    if (viewMode === 'formatted' && scene.formatted) return { text: scene.formatted }
    if (viewMode === 'raw') return { text: scene.raw }
    // 요청한 뷰가 없으면 있는 것 중 최선
    if (scene.translated) return { text: scene.translated }
    if (scene.formatted) return { text: scene.formatted }
    return { text: scene.raw }
  }

  const goScene = useCallback((idx, toBottom = false) => {
    const clamped = Math.max(0, Math.min(total - 1, idx))
    setSceneIdx(clamped)
    // 위로 올라온 경우엔 새 씬을 맨 아래부터 (읽던 흐름 유지), 아니면 맨 위
    setTimeout(() => { const el = contentRef.current; if (el) el.scrollTop = toBottom ? el.scrollHeight : 0 }, 0)
  }, [total])

  const scrollBy = useCallback((px) => {
    const el = contentRef.current
    if (!el) return false
    const before = el.scrollTop
    el.scrollBy({ top: px, behavior: 'smooth' })
    // 경계 도달 여부는 즉시 체크
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
    const atTop = el.scrollTop <= 0
    return { atBottom, atTop, moved: true }
  }, [])

  useEffect(() => {
    function handleKey(e) {
      // jump input 포커스 중이면 방향키 무시
      if (document.activeElement === jumpRef.current) return
      if (e.key === 'Escape') { onClose(); return }

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const idx = VIEWS.indexOf(viewMode)
        setViewMode(VIEWS[Math.max(0, idx - 1)])
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const idx = VIEWS.indexOf(viewMode)
        setViewMode(VIEWS[Math.min(VIEWS.length - 1, idx + 1)])
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const el = contentRef.current
        if (!el) return
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
        if (remaining <= el.clientHeight * 0.2) stepScene(1) // 바닥 근처면 바로 다음
        else el.scrollBy({ top: 120, behavior: 'smooth' })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const el = contentRef.current
        if (!el) return
        if (el.scrollTop <= 8) stepScene(-1)
        else el.scrollBy({ top: -120, behavior: 'smooth' })
      } else if (e.key === ' ') {
        e.preventDefault()
        const el = contentRef.current
        if (!el) return
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
        if (remaining <= el.clientHeight * 0.2) stepScene(1)
        else el.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' })
      } else if (e.key === 'c' || e.key === 'C') {
        setChecked(prev => {
          const next = new Set(prev)
          if (next.has(sceneIdx)) next.delete(sceneIdx)
          else next.add(sceneIdx)
          return next
        })
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [sceneIdx, viewMode, goScene, stepScene, onClose])

  function handleJump(e) {
    e.preventDefault()
    const n = parseInt(jumpInput) - 1
    if (!isNaN(n)) goScene(n)
    setJumpInput('')
    jumpRef.current?.blur()
  }

  const { text } = getContent()
  const isChecked = checked.has(sceneIdx)
  const checkedCount = checked.size

  return (
    <div style={{
      position: 'fixed', inset: 0, background: T.bg, zIndex: 200,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* 상단 바 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 20px', borderBottom: `1px solid ${T.rule}`,
        flexShrink: 0,
      }}>
        {/* 씬 이동 (검토 모드면 검토 씬만) */}
        <button onClick={() => stepScene(-1)} disabled={sceneIdx === 0 && !reviewOnly}
          style={navBtn(sceneIdx > 0 || reviewOnly)}>◀</button>
        <span style={{ color: T.fgMuted, fontSize: 13, minWidth: 80, textAlign: 'center' }}>
          {sceneIdx + 1} / {total}
        </span>
        <button onClick={() => stepScene(1)} disabled={sceneIdx === total - 1 && !reviewOnly}
          style={navBtn(sceneIdx < total - 1 || reviewOnly)}>▶</button>

        {/* 검토 필터 — 공식 자막과 표현 다른 씬만 */}
        {reviewIdxs.length > 0 && (
          <button onClick={() => setReviewOnly(v => !v)} title="공식 자막과 표현이 다른 줄(노랑 점선)이 있는 씬만 ◀▶로 넘기기"
            style={{ padding: '4px 11px', borderRadius: 3, border: `1px solid ${reviewOnly ? T.warn : T.rule}`,
              background: reviewOnly ? T.warn + '22' : 'none', color: reviewOnly ? T.warn : T.fgMuted, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            검토 {reviewIdxs.length}
          </button>
        )}

        {/* 씬 제목 */}
        <span style={{ flex: 1, color: T.fg, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {scene.heading || scene.raw.split('\n')[0].trim().slice(0, 60) || '(무제)'}
        </span>

        {/* 뷰 전환 */}
        <div style={{ display: 'flex', gap: 4 }}>
          {VIEWS.map(v => {
            const available = v === 'raw' || (v === 'formatted' && scene.formatted) || (v === 'translated' && scene.translated)
            return (
              <button key={v} onClick={() => setViewMode(v)} style={{
                padding: '4px 12px', borderRadius: 3, border: 'none', cursor: available ? 'pointer' : 'default',
                background: viewMode === v ? T.accent : T.chip,
                color: viewMode === v ? T.accentFg : available ? T.fgMuted : T.fgDim,
                fontSize: 12, fontWeight: viewMode === v ? 700 : 400,
                opacity: available ? 1 : 0.4,
              }}>{VIEW_LABEL[v]}</button>
            )
          })}
        </div>

        {/* 검수 체크 */}
        <button onClick={() => setChecked(prev => { const n = new Set(prev); if (n.has(sceneIdx)) n.delete(sceneIdx); else n.add(sceneIdx); return n })}
          style={{
            padding: '4px 12px', borderRadius: 3, border: `1px solid ${isChecked ? T.good : T.rule}`,
            background: isChecked ? T.good + '22' : 'none', cursor: 'pointer',
            color: isChecked ? T.good : T.fgDim, fontSize: 12,
          }}>
          {isChecked ? '✓ 검수됨' : '검수 (C)'}
        </button>

        {/* 씬 번호 점프 */}
        <form onSubmit={handleJump} style={{ display: 'flex', gap: 4 }}>
          <input
            ref={jumpRef}
            value={jumpInput}
            onChange={e => setJumpInput(e.target.value)}
            placeholder="씬#"
            style={{
              width: 52, padding: '4px 8px', borderRadius: 3,
              background: T.bgInput, border: `1px solid ${T.rule}`,
              color: T.fg, fontSize: 12, outline: 'none',
            }}
          />
        </form>

        {/* 닫기 */}
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.fgMuted, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
      </div>

      {/* 콘텐츠 */}
      <div ref={contentRef} style={{ flex: 1, overflowY: 'auto', padding: '32px 0' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px' }}>
          {scene.status !== 'done' && (
            <div style={{ color: T.fgDim, fontSize: 13, marginBottom: 16 }}>
              {scene.status === 'pending' && '아직 처리되지 않은 씬'}
              {scene.status === 'formatting' && '포맷 중...'}
              {scene.status === 'formatted' && '번역 대기 중'}
              {scene.status === 'translating' && '번역 중...'}
              {scene.status?.startsWith('error') && classifyError(scene.error).label}
            </div>
          )}
          <AnnotatedTranslation text={text} fontSize={15} />
        </div>
      </div>

      {/* 하단 상태 바 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 20px', borderTop: `1px solid ${T.rule}`,
        color: T.fgDim, fontSize: 11, flexShrink: 0,
      }}>
        <span>↑↓ 스크롤/씬이동 · ←→ 뷰전환 · Space 페이지 · C 검수 · Esc 닫기</span>
        {checkedCount > 0 && <span style={{ color: T.good }}>검수 완료 {checkedCount}/{total}씬</span>}
      </div>
    </div>
  )
}

function navBtn(enabled) {
  return {
    background: 'none', border: `1px solid ${T.rule}`, borderRadius: 3,
    color: enabled ? T.fgMuted : T.fgDim, fontSize: 12,
    padding: '4px 10px', cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.3,
  }
}
