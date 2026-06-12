import { useRef, useState } from 'react'
import { T, loadSettings, loadGuidelines } from '../lib/core.js'
import { detect, autofix, summarize } from '../lib/lint.js'

// 종합 수정 허브 — 번역본 드롭 → 자동 진단 → (무료)코드수정 자동 + (토큰)AI수정 선택 → 한 번에 적용
export default function LintPanel() {
  const ref = useRef()
  const [items, setItems] = useState([])   // [{name, text, sum, det, open, unify, instr, running, prog}]
  const [drag, setDrag] = useState(false)

  async function addFiles(fileList) {
    const next = []
    for (const f of Array.from(fileList || [])) {
      if (f.name.endsWith('.json')) {
        // 리더 수정요청 JSON
        try {
          const req = JSON.parse(await f.text())
          if (Array.isArray(req.items)) { next.push({ kind: 'fixreq', name: f.name, req, open: true, running: false, prog: null }); continue }
        } catch {}
      } else if (f.name.endsWith('.txt')) {
        const text = await f.text()
        next.push({ kind: 'txt', name: f.name, text, sum: summarize(text), det: detect(text), open: items.length === 0, unify: false, instr: '', running: false, prog: null })
      }
    }
    if (next.length) setItems(prev => [...prev, ...next])
  }
  const upd = (idx, patch) => setItems(prev => prev.map((x, i) => i === idx ? { ...x, ...patch } : x))

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
  }

  // ── 말투 사전 생성 (번역본 대사에서) ──
  async function makeRegister(text, model) {
    const lines = text.split('\n'); const pairs = []
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim(); if (!t.startsWith('@')) continue
      const cue = t.replace(/^@/, '').split('(')[0].trim()
      let j = i + 1; while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('('))) j++
      const d = lines[j]?.trim() || ''
      if (cue && d && !d.startsWith('@') && !d.startsWith('#')) pairs.push(`@${cue}: ${d.slice(0, 80)}`)
    }
    const cap = 200, step = pairs.length / cap
    const sample = (pairs.length > cap ? Array.from({ length: cap }, (_, k) => pairs[Math.floor(k * step)]) : pairs).join('\n').slice(0, 8000)
    if (!sample) return ''
    try {
      const r = await fetch('/api/character-register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dialogueSample: sample, model }) })
      return r.ok ? ((await r.json()).register || '') : ''
    } catch { return '' }
  }
  // ── 씬별 LLM 교정 ──
  async function reviseByScene(text, guidelines, model, onProg) {
    const chunks = text.split(/\n(?=# )/).filter(s => s.trim())
    const out = []
    for (let i = 0; i < chunks.length; i++) {
      try {
        const res = await fetch('/api/revise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sceneText: chunks[i], guidelines, mode: 'translated', sceneIndex: i, totalScenes: chunks.length, model }) })
        out.push(res.ok ? ((await res.json()).revised || chunks[i]) : chunks[i])
      } catch { out.push(chunks[i]) }
      onProg?.(i + 1, chunks.length)
    }
    return out.join('\n\n')
  }

  // ── 한 번에 적용: 코드수정(무료) → 말투통일 → 직접지시 ──
  async function applyAll(idx) {
    const it = items[idx]; if (it.running) return
    upd(idx, { running: true })
    const model = loadSettings().translateModel || loadSettings().model
    try {
      let text = autofix(it.text)                                  // 1) 코드 수정 (무료)
      if (it.unify) {                                              // 2) 말투 통일
        upd(idx, { prog: { phase: '말투 분석 중' } })
        const guide = await makeRegister(text, model)
        text = await reviseByScene(text,
          `아래 '인물 말투 가이드'대로 각 인물의 말투(반말/존댓말)·호칭만 일관되게 교정. 의미·표현·구조는 보존.\n\n[인물 말투 가이드]\n${guide}`,
          model, (d, t) => upd(idx, { prog: { phase: '말투 통일', d, t } }))
      }
      if (it.instr.trim()) {                                       // 3) 직접 지시
        text = await reviseByScene(text, it.instr.trim(), model, (d, t) => upd(idx, { prog: { phase: '지시 수정', d, t } }))
      }
      download(it.name.replace('.txt', '_수정.txt'), text)
    } finally { upd(idx, { running: false, prog: null }) }
  }

  // ── 리더 수정요청 JSON → AI 교정 → 오버레이 다운로드 ──
  async function runFixReq(idx) {
    const it = items[idx]; if (it.running || !it.req?.items?.length) return
    upd(idx, { running: true, prog: { d: 0, t: it.req.items.length } })
    const guidelines = loadGuidelines('translate')
    const model = loadSettings().translateModel || loadSettings().model
    const edits = {}
    for (let i = 0; i < it.req.items.length; i++) {
      const q = it.req.items[i]
      if (q.ko) {
        const note = [q.tags?.length ? `[${q.tags.join('·')}]` : '', q.memo || ''].filter(Boolean).join(' ')
        try {
          const res = await fetch('/api/fix-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ko: q.ko, en: q.en, note, guidelines, model }) })
          if (res.ok) { const { fixed } = await res.json(); if (fixed && fixed !== q.ko) edits[q.blockId] = fixed }
        } catch {}
      }
      upd(idx, { prog: { d: i + 1, t: it.req.items.length } })
    }
    download(`${it.req.id || 'overlay'}_수정.json`, JSON.stringify({ id: it.req.id, title: it.req.title, edits }, null, 2))
    upd(idx, { running: false, prog: null })
    alert(`${Object.keys(edits).length}개 교정 완료 → 리더에서 '수정 가져오기'로 반영하세요.`)
  }

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
      <div style={{ color: T.fg, fontWeight: 600, fontSize: 13, marginBottom: 4 }}>수정 <span style={{ color: T.fgDim, fontWeight: 400 }}>(파일 드롭하면 알아서 판별·진단)</span></div>
      <div style={{ color: T.fgDim, fontSize: 12, marginBottom: 10 }}><code>_translated.txt</code> = 검수+말투통일+지시 / <code>_수정요청.json</code>(리더) = AI 교정→오버레이. <b>코드 수정은 무료·자동</b>, AI 수정만 선택하면 한 번에 적용.</div>

      <div
        onClick={() => ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
        style={{ border: `2px dashed ${drag ? T.accent : T.rule}`, borderRadius: 3, padding: '18px', textAlign: 'center', cursor: 'pointer', background: T.bgCard, marginBottom: 12 }}>
        <span style={{ color: T.fgMuted, fontSize: 13 }}>.txt 번역본 · .json 수정요청 드롭 (여러 개 가능)</span>
      </div>
      <input ref={ref} type="file" accept=".txt,.json" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />

      {items.map((it, idx) => {
        // 리더 수정요청 JSON
        if (it.kind === 'fixreq') return (
          <div key={idx} style={{ background: T.bgCard, borderRadius: 3, marginBottom: 6, padding: '12px' }}>
            <div style={{ color: T.fg, fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{it.name} <span style={{ color: T.fgDim, fontWeight: 400 }}>· 리더 수정요청</span></div>
            <div style={{ color: T.fgMuted, fontSize: 12, marginBottom: 10 }}>{it.req.title || it.req.id} · 마크 {it.req.items.length}건 → AI 교정 후 오버레이(.json) 다운로드. (원본 안 건드림)</div>
            <button onClick={() => runFixReq(idx)} disabled={it.running}
              style={{ padding: '8px 16px', borderRadius: 3, border: 'none', background: it.running ? T.chip : T.accent, color: it.running ? T.fgDim : '#fff', fontWeight: 700, fontSize: 13, cursor: it.running ? 'default' : 'pointer' }}>
              {it.running ? `교정 중 ${it.prog?.d || 0}/${it.prog?.t || 0}` : 'AI 교정 → 오버레이 다운로드'}
            </button>
          </div>
        )
        const s = it.sum, d = it.det
        const codeFixes = s.autofixable
        return (
          <div key={idx} style={{ background: T.bgCard, borderRadius: 3, marginBottom: 6, overflow: 'hidden' }}>
            <div onClick={() => upd(idx, { open: !it.open })}
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
              {codeFixes === 0 && s.review === 0 && s.miscue === 0 && <span style={{ fontSize: 11, color: T.good }}>✓ 깨끗</span>}
              <span style={{ color: T.fgDim, fontSize: 11 }}>{it.open ? '▲' : '▼'}</span>
            </div>
            {it.open && (
              <div style={{ borderTop: `1px solid ${T.rule}`, padding: '12px' }}>
                {/* 코드 수정 (자동·무료) */}
                <div style={{ fontSize: 12, color: codeFixes > 0 ? T.fg : T.fgDim, marginBottom: 8 }}>
                  {codeFixes > 0 ? `✓ 코드 수정 ${codeFixes}건 자동 포함 (무료) — 메타·헤더·중복·줄나눔·헤딩숫자` : '코드 수정할 것 없음'}
                </div>

                {/* 검토용(자동수정 안 함) */}
                {(d.dialog.length > 0 || d.miscue.length > 0) && (
                  <div style={{ marginBottom: 10, paddingLeft: 8, borderLeft: `2px solid ${T.warn}66` }}>
                    {d.dialog.length > 0 && <div style={{ color: T.warn, fontSize: 12, fontWeight: 600 }}>⚠ 미번역 의심 {d.dialog.length} <span style={{ color: T.fgDim, fontWeight: 400 }}>(의도된 외국어일 수도 — 사람이 확인)</span></div>}
                    {d.dialog.slice(0, 8).map(i => <Line key={'d' + i} i={i} lines={d.lines} />)}
                    {d.miscue.length > 0 && <div style={{ color: T.warn, fontSize: 12, fontWeight: 600, marginTop: 6 }}>⚠ 의심 화자 {d.miscue.length} <span style={{ color: T.fgDim, fontWeight: 400 }}>(시간/전환 슬러그가 @로 오태깅)</span></div>}
                    {d.miscue.slice(0, 8).map(i => <Line key={'m' + i} i={i} lines={d.lines} />)}
                  </div>
                )}

                {/* AI 수정 (토큰 — 선택) */}
                <div style={{ fontSize: 11, fontWeight: 700, color: T.fgDim, letterSpacing: '.05em', margin: '4px 0 6px' }}>AI 수정 (토큰 사용 · 선택)</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.fg, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" checked={it.unify} onChange={e => upd(idx, { unify: e.target.checked })} />
                  말투 통일 <span style={{ color: T.fgDim, fontSize: 12 }}>— 반말/존댓말·호칭 일관성 (의미 보존)</span>
                </label>
                <input value={it.instr} onChange={e => upd(idx, { instr: e.target.value })} placeholder="직접 지시 (예: 욕설 더 순화 / 호칭을 ~로) — 비우면 안 함"
                  style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 10px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13, marginBottom: 10 }} />

                <button onClick={() => applyAll(idx)} disabled={it.running}
                  style={{ padding: '9px 18px', borderRadius: 3, border: 'none', background: it.running ? T.chip : T.accent, color: it.running ? T.fgDim : '#fff', fontWeight: 700, fontSize: 13, cursor: it.running ? 'default' : 'pointer' }}>
                  {it.running ? `${it.prog?.phase || '처리 중'} ${it.prog?.t ? `${it.prog.d}/${it.prog.t}` : ''}` : '수정 적용 → 다운로드'}
                </button>
                <span style={{ fontSize: 11, color: T.fgDim, marginLeft: 10 }}>
                  {it.unify || it.instr.trim() ? '코드수정 + 선택한 AI수정 함께 적용' : codeFixes > 0 ? '코드수정만 적용 (무료)' : '적용할 것 없음'}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
