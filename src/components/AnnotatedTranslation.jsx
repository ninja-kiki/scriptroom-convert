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
  const smiCount = smiMatches.filter(m => m.replaced).length

  return (
    <div>
      {smiCount > 0 && (
        <div style={{ color: T.fgDim, fontSize: 11, marginBottom: 6 }}>
          자막 적용 {smiCount}줄 <span style={{ color: T.accent }}>──</span> 밑줄 표시
        </div>
      )}
      <pre style={{ ...preStyle(fontSize), whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {lines.map((line, idx) => {
          const m = matchByLine[idx]
          if (!m) return <span key={idx}>{line + '\n'}</span>
          if (m.replaced) {
            return (
              <span key={idx} style={{ position: 'relative' }}>
                <span onClick={() => setTooltip(tooltip?.lineIdx === idx ? null : { lineIdx: idx })}
                  style={{ textDecoration: 'underline', textDecorationColor: T.accent, textUnderlineOffset: 3, color: T.fg, cursor: 'pointer' }}>
                  {line}
                </span>
                {tooltip?.lineIdx === idx && (
                  <span style={tooltipStyle()}>
                    <span style={{ color: T.accent }}>자막</span> {m.smiText}<br/>
                    <span style={{ color: T.fgDim }}>AI번역</span> <span style={{ color: T.fgMuted }}>{m.original}</span><br/>
                    <span style={{ color: T.fgDim }}>유사도</span> <span style={{ color: T.fgMuted }}>{Math.round(m.similarity * 100)}%</span>
                  </span>
                )}
                {'\n'}
              </span>
            )
          } else {
            return (
              <span key={idx} style={{ position: 'relative' }}>
                <span onClick={() => setTooltip(tooltip?.lineIdx === idx ? null : { lineIdx: idx })}
                  style={{ cursor: 'pointer', color: T.fg }}>{line}</span>
                {tooltip?.lineIdx === idx && (
                  <span style={{ ...tooltipStyle(), borderColor: T.rule }}>
                    <span style={{ color: T.fgDim }}>자막 미적용</span><br/>
                    {m.smiText
                      ? <><span style={{ color: T.fgDim }}>최근접 자막</span> <span style={{ color: T.fgMuted }}>{m.smiText}</span><br/><span style={{ color: T.fgDim }}>유사도</span> <span style={{ color: T.fgMuted }}>{Math.round(m.similarity * 100)}% (기준 미달)</span></>
                      : <span style={{ color: T.fgDim }}>자막에서 유사 대사 없음</span>
                    }
                  </span>
                )}
                {'\n'}
              </span>
            )
          }
        })}
      </pre>
    </div>
  )
}

const preStyle = (fontSize) => ({
  fontFamily: 'monospace', fontSize, color: T.fg,
  lineHeight: 1.9, margin: 0,
})

