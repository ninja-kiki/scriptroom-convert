import { T } from '../lib/core.js'

// 번역본 렌더. 대부분은 평문(monospace)이지만, [크레딧: …]·[자막: …] 마커는 영화처럼 연출.
//  (자막 유사도 매칭은 제거됨 — 각본과 영화자막은 본디 유사하기 힘들어 혼란만 줌.)
export default function AnnotatedTranslation({ text, fontSize = 12 }) {
  const lines = (text || '').split('\n')
  // 마커 블록([크레딧:/자막: … ]) 단위로 묶고, 나머지 평문 줄은 이어서 하나의 pre로
  const blocks = []
  let plain = []
  const flushPlain = () => { if (plain.length) { blocks.push({ type: 'plain', text: plain.join('\n') }); plain = [] } }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[(크레딧|자막)\s*:/)
    if (m) {
      let j = i, buf = [lines[i]]
      while (j < lines.length && !/\]\s*$/.test(lines[j])) { j++; if (j < lines.length) buf.push(lines[j]) }
      const content = buf.join('\n').replace(/^\s*\[(크레딧|자막)\s*:\s*/, '').replace(/\]\s*$/, '').trim()
      flushPlain()
      blocks.push({ type: m[1], text: content })
      i = j
    } else plain.push(lines[i])
  }
  flushPlain()

  return (
    <div>
      {blocks.map((b, i) => {
        if (b.type === '크레딧') return (
          <div key={i} style={{ margin: '18px 0', padding: '16px 18px', textAlign: 'center', borderTop: `1px solid ${T.rule}`, borderBottom: `1px solid ${T.rule}` }}>
            <div style={{ fontSize: 9.5, letterSpacing: 2, color: T.fgDim, textTransform: 'uppercase', marginBottom: 8 }}>Credit</div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: fontSize + 3, lineHeight: 1.75, color: T.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.text}</div>
          </div>
        )
        if (b.type === '자막') return (
          <div key={i} style={{ margin: '10px 0', display: 'flex', justifyContent: 'center' }}>
            <div style={{ maxWidth: '85%', padding: '5px 14px', borderRadius: 4, background: T.fg + '10', textAlign: 'center', fontStyle: 'italic', fontSize: fontSize + 1, lineHeight: 1.6, color: T.fgMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.text}</div>
          </div>
        )
        return <pre key={i} style={preStyle(fontSize)}>{b.text}</pre>
      })}
    </div>
  )
}

const preStyle = (fontSize) => ({
  fontFamily: 'monospace', fontSize, color: T.fg,
  lineHeight: 1.9, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
})
