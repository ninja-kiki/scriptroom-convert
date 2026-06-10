import { useState } from 'react'
import { T } from '../lib/core.js'

export default function ReviewStep({ title, scenes, smiFile, smiWarning, pdfWarnings = [], processInfo, smiInfo, onStart }) {
  const methodLabel = !processInfo ? null
    : processInfo.method === 'ai' ? 'AI 분석'
    : processInfo.method === 'regex' ? '규칙 분석'
    : processInfo.method === 'ai→regex' ? 'AI 실패 → 규칙 분석'
    : '분석'
  const [expandedWarning, setExpandedWarning] = useState(null)

  const hasErrors = pdfWarnings.some(w => w.level === 'error')
  const hasWarns = pdfWarnings.some(w => w.level === 'warn')
  const allFormatted = scenes.length > 0 && scenes.every(s => s.status === 'formatted' && s.formatted)

  // 표시용: 앞뒤 씬번호(6 … 6 / B10 … B10) 떼서 깔끔하게
  const cleanHeading = h => h
    .replace(/^[A-Z]{0,2}\d+\.?\s+/, '')
    .replace(/\s+[A-Z]{0,2}\d+\.?$/, '')
    .trim()
  const headings = scenes
    .map(s => ({ id: s.id, heading: cleanHeading((s.formatted || s.raw).split('\n')[0].trim()) }))
    .filter(s => s.heading)

  return (
    <div style={{ padding: '24px 20px', maxWidth: 560, margin: '0 auto' }}>

      {/* 요약 헤더 */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ color: T.fg, fontSize: 18, fontWeight: 700, margin: 0 }}>{title}</h2>
        <span style={{ color: T.fgMuted, fontSize: 14 }}>{scenes.length}씬</span>
        {smiFile && !smiWarning && <span style={{ color: T.good, fontSize: 13 }}>자막 ✓</span>}
        {smiFile && smiWarning && <span style={{ color: T.warn, fontSize: 13 }}>자막 ⚠</span>}
      </div>

      {/* 신뢰 신호 — 믿고 가도 되는지 한눈에 */}
      {(() => {
        const hasCritical = hasErrors || pdfWarnings.some(w => ['few_scenes', 'undercount', 'low_heading_ratio', 'large_avg'].includes(w.code))
        const okAll = !hasCritical && !smiWarning
        const signals = []
        // 씬 인식
        signals.push(hasCritical
          ? { ok: false, text: `씬 인식 확인 필요 — 아래 경고 보기` }
          : { ok: true, text: `씬 ${scenes.length}개 인식${methodLabel ? ` · ${methodLabel}` : ''}` })
        // 자막
        if (smiInfo && smiInfo.count > 0) {
          signals.push(smiInfo.lang === 'ko'
            ? { ok: true, text: `한글 자막 ${smiInfo.count}줄 — 대사 번역에 활용` }
            : smiInfo.lang === 'en'
              ? { ok: true, text: `영어 자막 ${smiInfo.count}줄 — 구조 잡는 데 활용`, blue: true }
              : { ok: false, text: `자막 인식 실패 — 파일 확인` })
        } else {
          signals.push({ neutral: true, text: `자막 없음 — 대사 번역에 자막 도움은 못 받아요` })
        }
        return (
          <div style={{
            marginBottom: 16, borderRadius: 3, overflow: 'hidden', background: T.chip,
          }}>
            <div style={{ padding: '9px 14px', color: okAll ? T.accent : T.warn, fontSize: 13, fontWeight: 700 }}>
              {okAll ? '믿고 시작해도 좋아요' : '시작 전 아래 확인'}
            </div>
            <div style={{ padding: '4px 14px 8px' }}>
              {signals.map((sig, i) => {
                const c = sig.ok ? T.accent : sig.blue ? T.accent : sig.neutral ? T.fgDim : T.warn
                const icon = sig.ok ? '✓' : sig.neutral ? '·' : '⚠'
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13, color: sig.neutral ? T.fgDim : T.fgMuted }}>
                    <span style={{ color: c, fontWeight: 700, width: 14, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
                    <span>{sig.text}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {smiWarning && (
        <div style={{
          background: T.chip,
          borderRadius: 3, padding: '12px 16px', marginBottom: 16,
          color: T.warn, fontSize: 13,
        }}>
          ⚠ {smiWarning}
        </div>
      )}

      {/* PDF 분석 경고 */}
      {pdfWarnings.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {pdfWarnings.map(w => {
            const color = w.level === 'error' ? T.err : w.level === 'warn' ? T.warn : T.fgMuted
            const icon = w.level === 'error' ? '✕' : w.level === 'warn' ? '⚠' : 'i'
            const isOpen = expandedWarning === w.code
            return (
              <div key={w.code} style={{
                background: T.chip,
                borderRadius: 3, marginBottom: 6, overflow: 'hidden',
              }}>
                <div
                  onClick={() => setExpandedWarning(isOpen ? null : w.code)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9,
                    padding: '10px 14px', cursor: 'pointer',
                  }}
                >
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                    background: color + '33', border: `1.5px solid ${color}`,
                    color, fontSize: 11, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{icon}</span>
                  <span style={{ flex: 1, color, fontSize: 13, fontWeight: 500 }}>{w.label}</span>
                  <span style={{ color: color + '88', fontSize: 11 }}>{isOpen ? '▲' : '▼'}</span>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 14px 12px 42px', color: T.fgMuted, fontSize: 12, lineHeight: 1.6 }}>
                    {w.detail}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 씬 목록 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase' }}>씬 목록</span>
          {methodLabel && (
            <span style={{ color: T.fgDim, fontSize: 11 }}>
              · 씬 감지: {methodLabel}
              {processInfo.aiDropped > 0 && ` (오탐 ${processInfo.aiDropped}개 제외)`}
              {' · '}{processInfo.scenes}씬
            </span>
          )}
        </div>
        <div style={{
          maxHeight: 280, overflowY: 'auto',
          borderRadius: 3, border: `1px solid ${T.rule}`,
          scrollbarWidth: 'none',
        }}>
          {headings.map((s, i) => (
            <div key={s.id} style={{
              padding: '9px 14px',
              borderBottom: i < headings.length - 1 ? `1px solid ${T.rule}` : 'none',
              display: 'flex', gap: 12, alignItems: 'baseline',
              background: i % 2 === 0 ? T.bgCard : 'transparent',
            }}>
              <span style={{ color: T.fgDim, fontSize: 11, minWidth: 22, flexShrink: 0 }}>{i + 1}</span>
              <span style={{ color: T.fg, fontSize: 13, lineHeight: 1.4 }}>{s.heading.slice(0, 90)}</span>
            </div>
          ))}
        </div>
      </div>


      {/* 변환/번역 시작 버튼 */}
      {allFormatted && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 3,
          background: T.chip, color: T.accent, fontSize: 13,
        }}>
          ✓ 포맷 완료 파일 — 번역만 진행합니다
        </div>
      )}
      <button
        onClick={() => {
          if (hasErrors && !window.confirm('씬 분리 오류가 감지되었습니다. 그래도 변환을 시작할까요?')) return
          onStart('')
        }}
        style={{
          padding: '11px 28px', borderRadius: 3,
          background: hasErrors ? T.err : T.accent,
          border: 'none',
          color: T.accentFg, fontWeight: 700, fontSize: 15, cursor: 'pointer',
          display: 'block', width: '100%',
        }}
      >
        {allFormatted ? '번역 시작' : hasErrors ? '⚠ 경고 확인 후 변환 시작' : hasWarns ? '변환 시작 (경고 있음)' : '변환 시작'}
      </button>
    </div>
  )
}
