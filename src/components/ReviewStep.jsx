import { useState, useMemo } from 'react'
import { T } from '../lib/core.js'

function detectCharacters(scenes) {
  const counts = {}
  for (const scene of scenes) {
    const lines = scene.raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (/^[A-Z][A-Z0-9 .'-]{1,29}$/.test(line) && line.length >= 2) {
        const next = lines[i + 1]?.trim() || ''
        if (next && !/^(INT\.|EXT\.|CUT |FADE)/.test(next)) {
          counts[line] = (counts[line] || 0) + 1
        }
      }
    }
  }
  return Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }))
}

export default function ReviewStep({ title, scenes, smiFile, smiWarning, pdfWarnings = [], onStart }) {
  const [characterMemo, setCharacterMemo] = useState('')
  const [memoOpen, setMemoOpen] = useState(false)
  const [expandedWarning, setExpandedWarning] = useState(null)
  const characters = useMemo(() => detectCharacters(scenes), [scenes])

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

  function insertCharacter(name) {
    setCharacterMemo(m => m ? m + '\n' + name + ': ' : name + ': ')
  }

  return (
    <div style={{ padding: '24px 20px', maxWidth: 560, margin: '0 auto' }}>

      {/* 요약 헤더 */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ color: T.fg, fontSize: 18, fontWeight: 700, margin: 0 }}>{title}</h2>
        <span style={{ color: T.fgMuted, fontSize: 14 }}>{scenes.length}씬</span>
        {smiFile && !smiWarning && <span style={{ color: T.good, fontSize: 13 }}>자막 ✓</span>}
        {smiFile && smiWarning && <span style={{ color: T.warn, fontSize: 13 }}>자막 ⚠</span>}
      </div>

      {smiWarning && (
        <div style={{
          background: T.warn + '22', border: `1px solid ${T.warn}`,
          borderRadius: 10, padding: '12px 16px', marginBottom: 16,
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
            const bg = w.level === 'error' ? T.err + '18' : w.level === 'warn' ? T.warn + '14' : T.chip
            const icon = w.level === 'error' ? '✕' : w.level === 'warn' ? '⚠' : 'i'
            const isOpen = expandedWarning === w.code
            return (
              <div key={w.code} style={{
                background: bg, border: `1px solid ${color}44`,
                borderRadius: 9, marginBottom: 6, overflow: 'hidden',
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
        <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 8 }}>씬 목록</div>
        <div style={{
          maxHeight: 280, overflowY: 'auto',
          borderRadius: 10, border: `1px solid ${T.rule}`,
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

      {/* 인물 메모 (접힘) */}
      <div style={{ marginBottom: 20 }}>
        <button onClick={() => setMemoOpen(v => !v)} style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          background: 'none', border: 'none', padding: '6px 0', cursor: 'pointer', textAlign: 'left',
        }}>
          <span style={{ color: T.fgDim, fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase' }}>인물 메모</span>
          <span style={{ color: T.fgDim, fontSize: 11 }}>(선택)</span>
          <span style={{ color: T.fgDim, fontSize: 12, marginLeft: 'auto' }}>{memoOpen ? '▲' : '▼'}</span>
        </button>

        {memoOpen && (
          <div style={{ marginTop: 8 }}>
            {characters.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                {characters.map(c => (
                  <button key={c.name} onClick={() => insertCharacter(c.name)}
                    style={{
                      padding: '3px 9px', borderRadius: 5,
                      background: T.chip, border: `1px solid ${T.rule}`,
                      color: T.fgMuted, fontSize: 12, cursor: 'pointer',
                    }}>
                    {c.name}
                    <span style={{ color: T.fgDim, fontSize: 10, marginLeft: 3 }}>×{c.count}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={characterMemo}
              onChange={e => setCharacterMemo(e.target.value)}
              placeholder={'예: HOWARD = 주인공, 40대 보석상\nEDDIE = Howard 아들 → 부를 때 "아빠"'}
              style={{
                width: '100%', minHeight: 80, resize: 'vertical',
                background: T.bgInput, border: `1px solid ${T.rule}`,
                borderRadius: 8, color: T.fg, fontSize: 13,
                padding: 10, fontFamily: 'monospace', lineHeight: 1.6, outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}
      </div>

      {/* 변환/번역 시작 버튼 */}
      {allFormatted && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 9,
          background: T.good + '18', border: `1px solid ${T.good}44`,
          color: T.good, fontSize: 13,
        }}>
          ✓ 포맷 완료 파일 — 번역만 진행합니다
        </div>
      )}
      <button
        onClick={() => {
          if (hasErrors && !window.confirm('씬 분리 오류가 감지되었습니다. 그래도 변환을 시작할까요?')) return
          onStart(characterMemo.trim())
        }}
        style={{
          padding: '11px 28px', borderRadius: 10,
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
