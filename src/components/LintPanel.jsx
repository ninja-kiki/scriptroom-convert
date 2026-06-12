import { useRef, useState } from 'react'
import { T } from '../lib/core.js'
import { detect, autofix, summarize } from '../lib/lint.js'

// 번역본(_translated.txt) 여러 개 넣고 코드 기반 검수 (토큰 0) + 자동수정 다운로드
export default function LintPanel() {
  const ref = useRef()
  const [items, setItems] = useState([])   // [{name, text, sum, det, open}]
  const [drag, setDrag] = useState(false)

  async function addFiles(fileList) {
    const next = []
    for (const f of Array.from(fileList || [])) {
      if (!f.name.endsWith('.txt')) continue
      const text = await f.text()
      next.push({ name: f.name, text, sum: summarize(text), det: detect(text), open: false })
    }
    if (next.length) setItems(prev => [...prev, ...next])
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
  }
  const fixOne = it => download(it.name.replace('.txt', '_검수.txt'), autofix(it.text))
  function fixAll() { items.forEach(it => it.sum.autofixable && fixOne(it)) }

  const totalFix = items.reduce((n, it) => n + it.sum.autofixable, 0)
  const totalReview = items.reduce((n, it) => n + it.sum.review, 0)

  const Badge = ({ n, label, color }) => n > 0 && (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: T.chip, color: color || T.fgMuted }}>{label} {n}</span>
  )
  const Line = ({ i, lines }) => (
    <div style={{ fontSize: 12, color: T.fgMuted, padding: '2px 0', fontFamily: 'monospace' }}>
      <span style={{ color: T.fgDim }}>L{i + 1}</span> {lines[i].trim().slice(0, 80)}
    </div>
  )

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ color: T.fg, fontWeight: 600, fontSize: 13, marginBottom: 4 }}>번역본 검수 <span style={{ color: T.fgDim, fontWeight: 400 }}>(여러 개 가능 · 토큰 0)</span></div>
      <div style={{ color: T.fgDim, fontSize: 12, marginBottom: 10 }}>완료된 <code>_translated.txt</code>를 넣으면 메타·러닝헤더·중복·EN+KO중복·줄나눔·미번역 의심을 코드로 검사해요. 안전한 결함은 자동수정 후 다운로드.</div>

      <div
        onClick={() => ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
        style={{ border: `2px dashed ${drag ? T.accent : T.rule}`, borderRadius: 3, padding: '18px', textAlign: 'center', cursor: 'pointer', background: T.bgCard, marginBottom: 12 }}>
        <span style={{ color: T.fgMuted, fontSize: 13 }}>번역본 .txt 드롭 (여러 개)</span>
      </div>
      <input ref={ref} type="file" accept=".txt" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />

      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: T.fgMuted }}>{items.length}편 · 자동수정 {totalFix} · 확인필요 {totalReview}</span>
          {totalFix > 0 && <button onClick={fixAll} style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 3, border: 'none', background: T.accent, color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>전체 자동수정 다운로드</button>}
        </div>
      )}

      {items.map((it, idx) => {
        const s = it.sum, d = it.det
        return (
          <div key={idx} style={{ background: T.bgCard, borderRadius: 3, marginBottom: 6, overflow: 'hidden' }}>
            <div onClick={() => setItems(prev => prev.map((x, i) => i === idx ? { ...x, open: !x.open } : x))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer', flexWrap: 'wrap' }}>
              <span style={{ color: T.fg, fontSize: 13, flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
              <Badge n={s.meta} label="메타" color={T.err} />
              <Badge n={s.boiler} label="헤더" />
              <Badge n={s.bilingual} label="EN중복" />
              <Badge n={s.dupe} label="중복" />
              <Badge n={s.headNum} label="헤딩숫자" />
              <Badge n={s.spacing} label="줄나눔" color={T.warn} />
              <Badge n={s.dialog} label="미번역?" color={T.warn} />
              <Badge n={s.miscue} label="의심화자?" color={T.warn} />
              {s.autofixable === 0 && s.review === 0 && s.miscue === 0 && <span style={{ fontSize: 11, color: T.good }}>✓ 깨끗</span>}
              <span style={{ color: T.fgDim, fontSize: 11 }}>{it.open ? '▲' : '▼'}</span>
            </div>
            {it.open && (
              <div style={{ borderTop: `1px solid ${T.rule}`, padding: '10px 12px' }}>
                {s.autofixable > 0 && (
                  <button onClick={() => fixOne(it)} style={{ padding: '6px 12px', borderRadius: 3, border: 'none', background: T.accent, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>
                    자동수정 {s.autofixable}건 → 다운로드
                  </button>
                )}
                {d.dialog.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ color: T.warn, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>🔴 미번역 의심 {d.dialog.length} (사람이 확인 — 의도된 외국어일 수도)</div>
                    {d.dialog.slice(0, 20).map(i => <Line key={i} i={i} lines={d.lines} />)}
                    {d.dialog.length > 20 && <div style={{ color: T.fgDim, fontSize: 11 }}>…외 {d.dialog.length - 20}건</div>}
                  </div>
                )}
                {d.miscue.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ color: T.warn, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>⚠ 의심 화자 {d.miscue.length} (시간/전환 슬러그가 @로 잘못 태깅됐을 수 있음 — 확인 후 @ 제거)</div>
                    {d.miscue.slice(0, 20).map(i => <Line key={i} i={i} lines={d.lines} />)}
                  </div>
                )}
                {s.autofixable === 0 && d.dialog.length === 0 && d.miscue.length === 0 && <div style={{ color: T.good, fontSize: 12 }}>✓ 특이사항 없음</div>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
