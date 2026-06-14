import { useRef, useState } from 'react'
import { T, loadSettings, loadGuidelines } from '../lib/core.js'
import { detect, autofix, summarize, splitGluedAction } from '../lib/lint.js'

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
        const det = detect(text)
        next.push({ kind: 'txt', name: f.name, text, sum: summarize(text), det, open: items.length === 0, splitAction: det.glued.length > 0, unify: false, instr: '', running: false, prog: null })
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
      if (it.splitAction) text = splitGluedAction(text)            // 1.5) 대사 속 지문 분리 (무료)
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
      <div style={{ color: T.fg, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>번역본 다듬기</div>
      <div style={{ color: T.fgMuted, fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>
        완성된 번역본을 올리면 <b>자잘한 오류를 자동으로 찾아 무료로 고쳐</b> 줍니다.
        <span style={{ color: T.fgDim }}> (LLM 메타 코멘트·반복 머리말·중복 줄·줄나눔·대사에 붙은 지문) — 결과는 <code>_수정.txt</code>로 저장돼요.</span>
      </div>

      <div
        onClick={() => ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
        style={{ border: `2px dashed ${drag ? T.accent : T.rule}`, borderRadius: 4, padding: '28px 18px', textAlign: 'center', cursor: 'pointer', background: drag ? '#EBDFC4' : T.bgCard, marginBottom: 6, transition: 'background .15s' }}>
        <div style={{ color: T.fg, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>번역본 <code style={{ color: T.accent }}>.txt</code> 를 여기에 끌어다 놓으세요</div>
        <div style={{ color: T.fgDim, fontSize: 12 }}>여러 개 한꺼번에 가능 · 리더에서 내보낸 수정요청 <code>.json</code> 도 받아요</div>
      </div>
      <input ref={ref} type="file" accept=".txt,.json" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
      {items.length === 0 && (
        <div style={{ color: T.fgDim, fontSize: 12, lineHeight: 1.7, marginTop: 10, paddingLeft: 2 }}>
          <b style={{ color: T.fgMuted }}>이럴 때 쓰세요</b><br />
          · 변환이 끝난 번역본에서 자잘한 오류를 한 번에 정리하고 싶을 때<br />
          · 인물 말투(반말/존댓말)를 통일하고 싶을 때 <span style={{ color: T.fgDim }}>(AI 수정·선택)</span>
        </div>
      )}

      {items.map((it, idx) => {
        // 리더 수정요청 JSON
        if (it.kind === 'fixreq') return (
          <div key={idx} style={{ background: T.bgCard, borderRadius: 3, marginBottom: 6, padding: '12px' }}>
            <div style={{ color: T.fg, fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{it.name} <span style={{ color: T.fgDim, fontWeight: 400, fontSize: 12 }}>· 리더에서 표시한 수정요청</span></div>
            <div style={{ color: T.fgMuted, fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>{it.req.title || it.req.id} · 표시한 <b>{it.req.items.length}곳</b>을 AI가 고쳐서 <b>덮어쓰기용 파일(.json)</b>로 내려줘요. 리더에서 "수정 가져오기"로 반영하면 돼요. (번역본 원본은 안 바뀜)</div>
            <button onClick={() => runFixReq(idx)} disabled={it.running}
              style={{ padding: '8px 16px', borderRadius: 3, border: 'none', background: it.running ? T.chip : T.accent, color: it.running ? T.fgDim : '#fff', fontWeight: 700, fontSize: 13, cursor: it.running ? 'default' : 'pointer' }}>
              {it.running ? `교정 중 ${it.prog?.d || 0}/${it.prog?.t || 0}` : 'AI 교정 → 오버레이 다운로드'}
            </button>
          </div>
        )
        const s = it.sum, d = it.det
        const codeFixes = s.autofixable
        // 자동으로 고치는 것들 — 사람 말로
        const autoList = [
          s.meta && `AI가 흘린 메타 코멘트 ${s.meta}개`,
          s.boiler && `반복되는 머리말/꼬리말 ${s.boiler}개`,
          s.dupe && `똑같이 겹친 줄 ${s.dupe}개`,
          s.bilingual && `영어+한국어 중복 블록 ${s.bilingual}개`,
          s.headNum && `씬 제목 끝 숫자 ${s.headNum}개`,
          s.spacing && `들쭉날쭉한 줄나눔`,
        ].filter(Boolean)
        const reviewCount = d.dialog.length + d.miscue.length
        const clean = autoList.length === 0 && s.glued === 0 && reviewCount === 0
        return (
          <div key={idx} style={{ background: T.bgCard, borderRadius: 4, marginBottom: 8, overflow: 'hidden', border: `1px solid ${T.rule}` }}>
            <div onClick={() => upd(idx, { open: !it.open })}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer' }}>
              <span style={{ color: T.fg, fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
              {clean
                ? <span style={{ fontSize: 12.5, color: T.good, fontWeight: 600 }}>✓ 깨끗해요</span>
                : <span style={{ fontSize: 12.5, color: T.fgMuted }}>
                    {autoList.length + (s.glued > 0 ? 1 : 0) > 0 && <span style={{ color: T.accent, fontWeight: 600 }}>고칠 것 {autoList.length + (s.glued > 0 ? 1 : 0)}</span>}
                    {reviewCount > 0 && <span style={{ color: T.warn }}>{(autoList.length || s.glued) ? ' · ' : ''}확인 {reviewCount}</span>}
                  </span>}
              <span style={{ color: T.fgDim, fontSize: 12 }}>{it.open ? '▲' : '▼'}</span>
            </div>
            {it.open && (
              <div style={{ borderTop: `1px solid ${T.rule}`, padding: '14px' }}>
                {/* ① 자동으로 고침 (무료) */}
                {(autoList.length > 0 || s.glued > 0) ? (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: T.good, marginBottom: 6 }}>✓ 자동으로 고침 <span style={{ color: T.fgDim, fontWeight: 400 }}>(무료, 내용은 안 바뀜)</span></div>
                    {autoList.map((t, k) => <div key={k} style={{ fontSize: 13, color: T.fgMuted, padding: '2px 0' }}>· {t}</div>)}
                    {s.glued > 0 && (
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 13, color: T.fg, cursor: 'pointer', padding: '4px 0' }}>
                        <input type="checkbox" checked={it.splitAction} onChange={e => upd(idx, { splitAction: e.target.checked })} style={{ marginTop: 3 }} />
                        <span>· 대사에 붙은 <b>지문 {s.glued}개</b> 떼어내기 <span style={{ color: T.fgDim, fontSize: 12 }}>(@화자 대사에 붙은 행동·장면 묘사를 빈 줄로 분리)</span></span>
                      </label>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: T.fgDim, marginBottom: 14 }}>자동으로 고칠 건 없어요.</div>
                )}

                {/* ② 확인만 필요 (자동으로 안 고침) */}
                {reviewCount > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: T.warn, marginBottom: 4 }}>⚠ 눈으로 확인하세요 <span style={{ color: T.fgDim, fontWeight: 400 }}>(자동으로 안 건드림)</span></div>
                    {d.dialog.length > 0 && <div style={{ fontSize: 12.5, color: T.fgMuted }}>· 번역 안 된 듯한 줄 {d.dialog.length}개 <span style={{ color: T.fgDim }}>(일부러 둔 외국어일 수도)</span></div>}
                    {d.dialog.slice(0, 5).map(i => <Line key={'d' + i} i={i} lines={d.lines} />)}
                    {d.miscue.length > 0 && <div style={{ fontSize: 12.5, color: T.fgMuted, marginTop: 4 }}>· 화자(@)가 잘못 붙은 듯한 줄 {d.miscue.length}개 <span style={{ color: T.fgDim }}>(시간·전환 표시가 @로)</span></div>}
                    {d.miscue.slice(0, 5).map(i => <Line key={'m' + i} i={i} lines={d.lines} />)}
                  </div>
                )}

                {/* ③ AI로 더 다듬기 (선택) */}
                <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: T.fg, marginBottom: 8 }}>AI로 더 다듬기 <span style={{ color: T.fgDim, fontWeight: 400, fontSize: 11.5 }}>(토큰 사용 · 선택)</span></div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.fg, cursor: 'pointer', marginBottom: 8 }}>
                    <input type="checkbox" checked={it.unify} onChange={e => upd(idx, { unify: e.target.checked })} />
                    말투 통일 <span style={{ color: T.fgDim, fontSize: 12 }}>— 인물별 반말/존댓말·호칭을 일관되게 (뜻은 유지)</span>
                  </label>
                  <input value={it.instr} onChange={e => upd(idx, { instr: e.target.value })} placeholder="원하는 수정을 적어보세요 (예: 욕설 더 순화 / ○○를 △△로 바꿔줘) — 비우면 안 함"
                    style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13 }} />
                </div>

                <button className="sr-press" onClick={() => applyAll(idx)} disabled={it.running || (clean && !it.unify && !it.instr.trim())}
                  style={{ marginTop: 14, width: '100%', padding: '11px', borderRadius: 3, border: 'none', background: it.running ? T.chip : T.accent, color: it.running ? T.fgDim : '#fff', fontWeight: 700, fontSize: 14, cursor: it.running ? 'default' : 'pointer' }}>
                  {it.running ? `${it.prog?.phase || '처리 중'} ${it.prog?.t ? `${it.prog.d}/${it.prog.t}` : ''}` : '고치기 → _수정.txt 저장'}
                </button>
                <div style={{ fontSize: 11.5, color: T.fgDim, marginTop: 6, textAlign: 'center' }}>
                  {it.unify || it.instr.trim() ? '무료 자동 수정 + 선택한 AI 수정을 함께 적용해요' : (autoList.length > 0 || (s.glued > 0 && it.splitAction)) ? '무료 자동 수정만 적용해요 (토큰 0)' : '적용할 게 없어요'}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
