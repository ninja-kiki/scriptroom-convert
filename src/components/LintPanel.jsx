import { useRef, useState, useEffect } from 'react'
import { T, loadSettings, loadGuidelines } from '../lib/core.js'
import { detect, autofix, summarize, splitGluedAction } from '../lib/lint.js'

// 각본 파일 아이콘 (종이 문서 모양)
const DocIcon = ({ ext, active }) => (
  <svg width="32" height="40" viewBox="0 0 32 40" style={{ display: 'block' }}>
    <path d="M0 2 Q0 0 2 0 H21 L32 11 V38 Q32 40 30 40 H2 Q0 40 0 38 Z" fill={active ? '#FFFFFF' : '#C0C0C0'} />
    <path d="M21 0 L21 11 H32" fill="none" stroke={active ? '#DDDDDD' : '#AAAAAA'} strokeWidth="1" />
    <text x="16" y="29" textAnchor="middle" fontSize="7" fontWeight="700" fill={active ? '#444' : '#999'} fontFamily="monospace">{ext.toUpperCase()}</text>
  </svg>
)

// unused legacy (kept for potential reuse)
const exBox = (c) => ({
  flex: 1, minWidth: 0, margin: 0, padding: '6px 9px', background: T.bgInput,
  border: `1px solid ${T.rule}`, borderLeft: `2px solid ${c}`, borderRadius: 3,
  fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55, color: T.fgMuted,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'hidden',
})

// 종합 수정 허브 — 번역본 드롭 → 자동 진단 → (무료)코드수정 자동 + (토큰)AI수정 선택 → 한 번에 적용
export default function LintPanel() {
  const ref = useRef()
  const [items, setItems] = useState([])
  const [drag, setDrag] = useState(false)
  const [hoverNote, setHoverNote] = useState(null)

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
        next.push({ kind: 'txt', name: f.name, text, sum: summarize(text), det, open: items.length === 0, splitAction: det.glued.length > 0, unify: false, instr: '', advOpen: false, running: false, prog: null })
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
    <div style={{ marginBottom: 32 }}>
      {/* 드롭존 — 4:3 비율, 파일 아이콘 (주 입력) */}
      {(() => {
        const loadedByExt = {}
        for (const it of items) {
          const ext = it.name.split('.').pop().toLowerCase()
          if (!loadedByExt[ext]) loadedByExt[ext] = []
          loadedByExt[ext].push(it)
        }
        return (
          <div
            onClick={() => ref.current.click()}
            onDragOver={e => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
            style={{ border: `2px dashed ${drag ? T.accent : T.rule}`, boxSizing: 'border-box', borderRadius: 4, minHeight: 190, padding: '24px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, cursor: 'pointer', background: drag ? T.accent + '22' : T.bgCard, marginBottom: 12, transition: 'background .15s, border-color .15s' }}>
            <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end' }}>
              {['txt', 'json', 'pdf'].map(ext => {
                const loaded = loadedByExt[ext] || []
                const active = loaded.length > 0
                return (
                  <div key={ext} style={{ textAlign: 'center', opacity: active ? 1 : 0.3, transition: 'opacity .2s' }}>
                    <DocIcon ext={ext} active={active} />
                    <div style={{ fontSize: 9, color: active ? T.fg : T.fgDim, marginTop: 5, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {active ? (loaded.length > 1 ? `${loaded.length}개` : loaded[0].name.replace(/\.[^.]+$/, '')) : ext.toUpperCase()}
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{ color: T.fgDim, fontSize: 12 }}>
              {items.length > 0 ? '+ 더 추가하기' : '끌어다 놓거나 클릭'}
            </div>
          </div>
        )
      })()}
      <input ref={ref} type="file" accept=".txt,.json,.pdf" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />

      {items.length === 0 && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <div style={{ color: T.fgMuted, fontSize: 13, marginBottom: 11 }}>
            번역본을 넣으면 <b style={{ color: T.fg }}>군말·중복·줄나눔</b>을 자동으로 정리해요
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'center' }}>
            {['AI 군말 제거', '겹친 줄 정리', '대사 속 지문 분리', '말투 통일'].map(t => (
              <span key={t} style={{ fontSize: 11.5, color: T.fgMuted, background: T.chip, padding: '4px 11px', borderRadius: 999 }}>{t}</span>
            ))}
          </div>
        </div>
      )}

      {/* 보조 입구 — 내 폴더에 변환해둔 작품에서 바로 고르기(나만 사용 가능한 단축) */}
      <ReprocessSection />

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
          <div key={idx} style={{ background: T.bgCard, borderRadius: 4, marginBottom: 8, overflow: 'hidden' }}>
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
                {/* 한 줄 요약 (최소) */}
                {!clean && (
                  <div style={{ fontSize: 13, color: T.fgMuted, marginBottom: 12 }}>
                    {(autoList.length + (s.glued > 0 ? 1 : 0)) > 0 && <>자동 정리 <b style={{ color: T.fg }}>{autoList.length + (s.glued > 0 ? 1 : 0)}</b>곳</>}
                    {reviewCount > 0 && <span style={{ color: T.warn }}>{(autoList.length || s.glued) ? ' · ' : ''}확인 {reviewCount}곳</span>}
                  </div>
                )}

                {/* 강조 메인 버튼 — 딸깍 한 번 */}
                <button className="sr-press" onClick={() => applyAll(idx)} disabled={it.running || (clean && !it.unify && !it.instr.trim())}
                  style={{ width: '100%', padding: '13px', borderRadius: 4, border: 'none', background: (it.running || (clean && !it.unify && !it.instr.trim())) ? T.chip : T.accent, color: (it.running || (clean && !it.unify && !it.instr.trim())) ? T.fgDim : T.accentFg, fontWeight: 700, fontSize: 15, cursor: it.running ? 'default' : 'pointer', boxShadow: (it.running || clean) ? 'none' : `0 3px 12px ${T.accent}55` }}>
                  {it.running ? `${it.prog?.phase || '처리 중'} ${it.prog?.t ? `${it.prog.d}/${it.prog.t}` : ''}` : clean ? '✓ 깨끗해요' : '✦ 자동으로 고치기 → 저장'}
                </button>

                {/* 더 다듬기 (접힘) */}
                <button onClick={() => upd(idx, { advOpen: !it.advOpen })}
                  style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 12, cursor: 'pointer', marginTop: 10, padding: 0 }}>
                  AI로 더 다듬기 {it.advOpen ? '▲' : '▾'} <span style={{ fontSize: 11 }}>(말투 통일·직접 지시)</span>
                </button>
                {it.advOpen && (
                  <div style={{ marginTop: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.fg, cursor: 'pointer', marginBottom: 8 }}>
                      <input type="checkbox" checked={it.unify} onChange={e => upd(idx, { unify: e.target.checked })} />
                      말투 통일 <span style={{ color: T.fgDim, fontSize: 12 }}>— 인물별 반말/존댓말 일관되게</span>
                    </label>
                    <input value={it.instr} onChange={e => upd(idx, { instr: e.target.value })} placeholder="직접 지시 (예: 욕설 더 순화)"
                      style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13 }} />
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// 기존 작품 개선 — 서버 잡(reprocess.mjs)로 PDF 재추출(템포)→진단→재번역. 최상위 컴포넌트(상태 안정).
function ReprocessSection() {
  const [works, setWorks] = useState([])
  const [work, setWork] = useState('')
  const [instr, setInstr] = useState('')
  const [st, setSt] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { fetch('/api/works').then(r => r.json()).then(d => setWorks(d.works || [])).catch(() => {}) }, [])
  useEffect(() => {
    if (!st?.running) return
    const t = setInterval(async () => { try { setSt(await (await fetch('/api/reprocess-status')).json()) } catch {} }, 1500)
    return () => clearInterval(t)
  }, [st?.running])
  async function start() {
    if (!work || st?.running) return
    try {
      const autoGo = !!loadSettings().reprocAutoGo
      const r = await fetch('/api/reprocess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work, translateOnly: false, instruction: instr.trim(), autoGo }) })
      if (!r.ok) { alert('시작 실패: ' + (await r.text())); return }
      setSt({ running: true, work, log: [], done: false, phase: 'diagnosing' })
    } catch (e) { alert('시작 실패: ' + e.message) }
  }
  async function go() {
    try { await fetch('/api/reprocess-go', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setSt(s => ({ ...s, phase: 'translating' })) } catch (e) { alert(e.message) }
  }
  async function stop() {
    try { await fetch('/api/reprocess-stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setSt(s => ({ ...(s || {}), running: false, done: true, phase: 'stopped' })) } catch (e) { alert(e.message) }
  }
  const awaiting = st?.phase === 'awaiting_go'
  const busy = st?.running
  return (
    <div style={{ border: `1px solid ${T.rule}`, borderRadius: 6, marginBottom: 16, overflow: 'hidden' }}>
      <div onClick={() => setOpen(v => !v)} className="sr-press" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', cursor: 'pointer' }}>
        <span style={{ color: T.fgMuted, fontSize: 13, fontWeight: 600, flex: 1 }}>또는 변환해둔 작품 고르기 <span style={{ color: T.fgDim, fontWeight: 400, fontSize: 11.5 }}>· 내 폴더 단축</span></span>
        {busy && <span style={{ fontSize: 12, color: T.accent }}>진행 중…</span>}
        <span style={{ color: T.fgDim, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${T.rule}`, padding: 14 }}>
          <select value={work} onChange={e => setWork(e.target.value)} disabled={busy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13, marginBottom: 8 }}>
            <option value="">작품 선택…</option>
            {works.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
          <input value={instr} onChange={e => setInstr(e.target.value)} disabled={busy} placeholder="(선택) 수정 지시 — 예: 욕설 더 순화 / ○○ 호칭 통일"
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13, marginBottom: 10 }} />
          <button className="sr-press" onClick={start} disabled={!work || busy}
            style={{ width: '100%', padding: '12px', borderRadius: 4, border: 'none', background: (!work || busy) ? T.chip : T.accent, color: (!work || busy) ? T.fgDim : T.accentFg, fontWeight: 700, fontSize: 14.5, cursor: (!work || busy) ? 'default' : 'pointer', boxShadow: (!work || busy) ? 'none' : `0 3px 12px ${T.accent}55` }}>
            {busy ? '개선 중…' : '개선하기'}
          </button>
          {!busy && !st && <div style={{ fontSize: 11, color: T.fgDim, textAlign: 'center', marginTop: 6 }}>먼저 진단하고, 예상 시간 보여준 뒤 시작해요</div>}

          {/* 진단 후 대기 — 프로파일 + 예상시간 보여주고 GO 받기 */}
          {awaiting && st.profile && (() => {
            const imps = st.profile.improvements?.length ? st.profile.improvements : null
            return (
            <div style={{ marginTop: 14, border: `1px solid ${T.accent}55`, borderRadius: 6, padding: 14, background: T.accent + '0d' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: T.fg, marginBottom: 8 }}>{imps ? '이렇게 좋아져요' : '딱히 손볼 큰 문제는 없어요'}</div>
              {imps
                ? imps.map((t, i) => (
                    <div key={i} style={{ fontSize: 13, color: T.fgMuted, padding: '2px 0', display: 'flex', gap: 7 }}>
                      <span style={{ color: T.accent }}>✦</span><span>{t}</span>
                    </div>
                  ))
                : <div style={{ fontSize: 13, color: T.fgMuted }}>그래도 새 처방으로 다시 번역하면 조금 더 다듬어질 수 있어요.</div>}
              <button className="sr-press" onClick={go}
                style={{ width: '100%', marginTop: 12, padding: '13px', borderRadius: 4, border: 'none', background: T.accent, color: T.accentFg, fontWeight: 700, fontSize: 15, cursor: 'pointer', boxShadow: `0 3px 12px ${T.accent}66` }}>
                {imps ? '이대로 고치기' : '그래도 다시 번역하기'} <span style={{ fontWeight: 400, fontSize: 13 }}>· 약 {st.estMin}분</span>
              </button>
              <div style={{ fontSize: 11, color: T.fgDim, textAlign: 'center', marginTop: 6 }}>{st.sceneCount}씬 다시 번역해요</div>
            </div>
            )
          })()}

          {st && !awaiting && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 12, color: st.error ? T.err : st.done ? (st.phase === 'stopped' ? T.fgMuted : T.good) : T.fgMuted, fontWeight: 600, flex: 1 }}>
                  {st.error ? `오류: ${st.error}` : st.phase === 'stopped' ? '중단됨' : st.done ? `✓ 완료 — ${st.work} (리더 반영은 배포 한 번)` : st.phase === 'diagnosing' ? `${st.work} 진단 중…` : `${st.work} 번역 중…`}
                </div>
                {st.running && (
                  <button onClick={stop} style={{ padding: '5px 12px', borderRadius: 3, border: `1px solid ${T.err}`, background: 'none', color: T.err, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>중단</button>
                )}
              </div>
              <pre style={{ margin: 0, maxHeight: 180, overflowY: 'auto', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, padding: 10, fontSize: 11, lineHeight: 1.5, color: T.fgMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {(st.log || []).slice(-14).join('\n') || '시작 중…'}
              </pre>
            </div>
          )}
          <div style={{ fontSize: 11, color: T.fgDim, marginTop: 8, lineHeight: 1.5 }}>
            끝나면 리더에 반영하려면 배포(sync) 한 번 필요.
          </div>
        </div>
      )}
    </div>
  )
}
