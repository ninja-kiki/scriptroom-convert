import { useState } from 'react'
import { T } from '../lib/core.js'

const tooltipStyle = () => ({
  display: 'block', marginTop: 4, marginBottom: 4,
  background: T.bgInput, border: `1px solid ${T.accent}44`,
  borderRadius: 3, padding: '6px 10px', fontSize: 11,
  fontFamily: 'sans-serif', whiteSpace: 'normal',
})

export default function AnnotatedTranslation({ text, smiMatches, fontSize = 12 }) {
  const [tooltip, setTooltip] = useState(null)
  if (!smiMatches || smiMatches.length === 0) {
    return <pre style={preStyle(fontSize)}>{text}</pre>
  }

  const matchByLine = {}
  smiMatches.forEach(m => { matchByLine[m.lineIdx] = m })
  const lines = text.split('\n')
  const alignedCount = smiMatches.filter(m => m.aligned).length

  return (
    <div>
      {alignedCount > 0 && (
        <div style={{ color: T.fgDim, fontSize: 11, marginBottom: 6 }}>
          공식 자막과 정렬 {alignedCount}줄 <span style={{ color: T.accent }}>┄</span> 점선 — 클릭하면 공식 자막과 비교 (번역은 안 바뀜)
        </div>
      )}
      <pre style={{ ...preStyle(fontSize), whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {lines.map((line, idx) => {
          const m = matchByLine[idx]
          // 확신 정렬된 대사 줄만 표시 (참고용 — 텍스트 교체 없음)
          if (!m || !m.aligned) return <span key={idx}>{line + '\n'}</span>
          const diff = (m.smiText || '').trim() !== (m.original || '').trim()
          return (
            <span key={idx} style={{ position: 'relative' }}>
              <span onClick={() => setTooltip(tooltip?.lineIdx === idx ? null : { lineIdx: idx })}
                style={{ textDecoration: 'underline dotted', textDecorationColor: diff ? T.warn : T.accent, textUnderlineOffset: 3, color: T.fg, cursor: 'pointer' }}>
                {line}
              </span>
              {tooltip?.lineIdx === idx && (
                <span style={tooltipStyle()}>
                  <span style={{ color: T.accent }}>이 번역</span> {m.original}<br/>
                  <span style={{ color: diff ? T.warn : T.fgDim }}>공식 자막</span> <span style={{ color: T.fgMuted }}>{m.smiText}</span><br/>
                  <span style={{ color: T.fgDim }}>유사도 {Math.round(m.similarity * 100)}%{diff ? ' · 표현 다름(검토)' : ' · 거의 동일'}</span>
                </span>
              )}
              {'\n'}
            </span>
          )
        })}
      </pre>
    </div>
  )
}

const preStyle = (fontSize) => ({
  fontFamily: 'monospace', fontSize, color: T.fg,
  lineHeight: 1.9, margin: 0,
})

