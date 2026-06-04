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

export default function ReviewStep({ title, scenes, smiFile, onStart }) {
  const [characterMemo, setCharacterMemo] = useState('')
  const [memoOpen, setMemoOpen] = useState(false)
  const characters = useMemo(() => detectCharacters(scenes), [scenes])

  const headings = scenes
    .map(s => ({ id: s.id, heading: s.raw.split('\n')[0].trim() }))
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
        {smiFile && <span style={{ color: T.good, fontSize: 13 }}>자막 ✓</span>}
      </div>

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

      {/* 변환 시작 버튼 */}
      <button onClick={() => onStart(characterMemo.trim())} style={{
        padding: '11px 28px', borderRadius: 10,
        background: T.accent, border: 'none',
        color: T.accentFg, fontWeight: 700, fontSize: 15, cursor: 'pointer',
        display: 'block', width: '100%',
      }}>
        변환 시작
      </button>
    </div>
  )
}
