import { useState } from 'react'
import { T, loadGuidelines, saveGuidelines } from '../lib/core.js'

export default function GuidelinesPanel({ onClose }) {
  const [tab, setTab] = useState('format')
  const [formatText, setFormatText] = useState(() => loadGuidelines('format'))
  const [translateText, setTranslateText] = useState(() => loadGuidelines('translate'))
  const [saved, setSaved] = useState(false)

  function handleSave() {
    saveGuidelines('format', formatText)
    saveGuidelines('translate', translateText)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const text = tab === 'format' ? formatText : translateText
  const setText = tab === 'format' ? setFormatText : setTranslateText

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
          padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {['format', 'translate'].map(t => (
              <button key={t} onClick={() => setTab(t)}
                style={{
                  padding: '6px 14px', borderRadius: 6, border: 'none',
                  background: tab === t ? T.accent : T.chip,
                  color: tab === t ? T.accentFg : T.fgMuted,
                  fontSize: 13, cursor: 'pointer', fontWeight: tab === t ? 600 : 400,
                }}>
                {t === 'format' ? '포맷 지침' : '번역 지침'}
              </button>
            ))}
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.fgMuted, fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          style={{
            flex: 1, minHeight: 300, resize: 'none',
            background: T.bgInput, border: `1px solid ${T.rule}`,
            borderRadius: 8, color: T.fg, fontSize: 13,
            padding: 14, fontFamily: 'monospace', lineHeight: 1.6,
            outline: 'none',
          }}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={handleSave}
            style={{
              flex: 1, padding: '12px', borderRadius: 8, border: 'none',
              background: saved ? T.good : T.accent,
              color: T.accentFg, fontWeight: 700, fontSize: 15, cursor: 'pointer',
            }}>
            {saved ? '저장됨 ✓' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
