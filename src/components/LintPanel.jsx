import { useRef, useState, useEffect } from 'react'
import { T, loadSettings, loadGuidelines } from '../lib/core.js'
import { detect, autofix, summarize, splitGluedAction, autofixChanges } from '../lib/lint.js'
import { buildDialogueSample, splitScenes } from '../lib/pipeline.js'

// 각본 파일 아이콘 (종이 문서 모양)
const DocIcon = ({ ext, active }) => (
  <svg width="32" height="40" viewBox="0 0 32 40" style={{ display: 'block' }}>
    <path d="M0 2 Q0 0 2 0 H21 L32 11 V38 Q32 40 30 40 H2 Q0 40 0 38 Z" fill={active ? '#FFFFFF' : '#C0C0C0'} />
    <path d="M21 0 L21 11 H32" fill="none" stroke={active ? '#DDDDDD' : '#AAAAAA'} strokeWidth="1" />
    <text x="16" y="29" textAnchor="middle" fontSize="7" fontWeight="700" fill={active ? '#444' : '#999'} fontFamily="monospace">{ext.toUpperCase()}</text>
  </svg>
)

// 칩별 예시 (누르면 before→after 한 줄씩)
const PILL_EX = {
  'AI 군말 제거': { before: '네, 알겠습니다. 아래에 번역본을 작성했습니다:\n\n# 1. 병원 복도 - 밤', after: '# 1. 병원 복도 - 밤' },
  '겹친 줄 정리': { before: '@의사\nHe needs surgery now.\n지금 당장 수술해야 합니다.', after: '@의사\n지금 당장 수술해야 합니다.' },
  '대사 속 지문 분리': { before: '@존\n(웃으며) 반가워 그는 천천히 손을 내밀었다.', after: '@존\n(웃으며) 반가워\n\n그는 천천히 손을 내밀었다.' },
  '말투 통일': { before: '@해리\n내가 알아서 할게.\n…\n@해리\n제가 알아서 하겠습니다.', after: '@해리\n내가 알아서 할게.\n…\n@해리\n내가 알아서 할게.' },
}

// 종합 수정 허브 — 번역본 드롭 → 자동 진단 → (무료)코드수정 자동 + (토큰)AI수정 선택 → 한 번에 적용
export default function LintPanel() {
  const ref = useRef()
  const [items, setItems] = useState([])
  const [drag, setDrag] = useState(false)
  const [hoverNote, setHoverNote] = useState(null)
  const [exPill, setExPill] = useState(null)  // 클릭한 예시 칩
  const [pdfNote, setPdfNote] = useState(false)  // PDF 넣었을 때 안내

  async function addFiles(fileList) {
    const others = []
    const txts = []
    const pdfs = []   // File 객체 (재추출 소스 — PDF '심판')
    for (const f of Array.from(fileList || [])) {
      if (f.name.endsWith('.json')) {
        try { const req = JSON.parse(await f.text()); if (Array.isArray(req.items)) others.push({ kind: 'fixreq', name: f.name, req, open: true, running: false, prog: null }) } catch {}
      } else if (f.name.endsWith('.txt')) {
        txts.push({ name: f.name, text: await f.text() })
      } else if (/\.pdf$/i.test(f.name)) { pdfs.push(f) }
    }
    // 같은 작품의 _formatted + _translated 를 한 카드로 묶음 (번역본 기준, 영어 포맷은 짝으로 부착)
    const groups = {}
    for (const t of txts) {
      const m = t.name.match(/^(.*?)_(formatted|translated)\.txt$/i)
      const base = m ? m[1] : t.name.replace(/\.txt$/i, '')
      const g = (groups[base] ||= { solo: [] })
      if (m && /formatted/i.test(m[2])) g.fmt = t
      else if (m && /translated/i.test(m[2])) g.tr = t
      else g.solo.push(t)
    }
    const norm = s => s.replace(/[-\s_]+/g, '').toLowerCase()
    const groupKeys = Object.keys(groups)
    const pdfFor = (base) => pdfs.find(p => norm(p.name.replace(/\.pdf$/i, '')) === norm(base))
      || (pdfs.length === 1 && groupKeys.length === 1 ? pdfs[0] : null)   // 1:1이면 이름 달라도 매칭
    const mkTxt = (main, pairFmt, pdfFile, formattedOnly) => {
      // formatted만 있고 translated가 없으면 — 영어 원문이라 한글 기준 검사(미번역·큐 등)는 의미 없음. 새로 번역 대상으로만 취급.
      const det = formattedOnly ? { meta: [], boiler: [], dupe: [], headNum: [], bilingual: [], dialog: [], struct: [], miscue: [], glued: [], repeat: [], spacing: 0, lines: main.text.split('\n').length } : detect(main.text)
      return { kind: 'txt', name: main.name, text: main.text, sum: summarize(formattedOnly ? '' : main.text), det, open: false, splitAction: det.glued.length > 0, unify: false, instr: '', running: false, prog: null, pairFmt: pairFmt || null, pdfFile: pdfFile || null, formattedOnly: !!formattedOnly }
    }
    const next = [...others]
    let matchedPdf = false
    for (const [base, g] of Object.entries(groups)) {
      const pdf = pdfFor(base); if (pdf) matchedPdf = true
      if (g.tr) next.push(mkTxt(g.tr, g.fmt ? { name: g.fmt.name, text: g.fmt.text } : null, pdf))   // 번역본 + 영어 짝 + PDF
      else if (g.fmt) next.push(mkTxt(g.fmt, null, pdf, true))   // 영어(원본)만 — 번역본 없음, 새로 번역 대상
      for (const s of g.solo) next.push(mkTxt(s, null, null))   // 짝 아닌 단독 txt
    }
    if (pdfs.length && !matchedPdf) setPdfNote(true)   // PDF는 넣었는데 짝을 못 찾음
    if (next.length) setItems(prev => {
      const wasEmpty = prev.length === 0
      const merged = [...prev, ...next]
      return wasEmpty ? merged.map((x, i) => (i === 0 ? { ...x, open: true } : x)) : merged
    })
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
    const chunks = splitScenes(text)
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
    const changes = autofixChanges(it.text)                        // 무료 diff (코드 수정 전후 변화)
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
      // 짝 영어 포맷도 같이 정리 (코드 청소만 — 줄나눔·페이지푸터·군말. 말투·지시는 한글 전용이라 미적용)
      if (it.pairFmt) {
        download(it.pairFmt.name.replace('.txt', '_수정.txt'), autofix(it.pairFmt.text))
      }
      upd(idx, { result: { ...changes, aiUnify: it.unify, aiInstr: it.instr.trim() || null } })   // 결과 카드용
    } finally { upd(idx, { running: false, prog: null }) }
  }

  // ── 재번역 (영어 포맷을 소스로 진단→씬별 번역). 미번역·꼬인 번역을 근본적으로 다시. 유료. ──
  async function retranslateDrop(idx) {
    const it = items[idx]
    if (it.running) return
    if (!it.pairFmt?.text && !it.pdfFile && !it.formattedOnly) return
    upd(idx, { running: true, result: null })
    const model = loadSettings().translateModel || loadSettings().model
    const guidelines = loadGuidelines('translate')
    try {
      // formattedOnly면 번역본 없이 원본(it.text)만 있는 상태 — 그게 곧 소스
      let fmt = it.pairFmt?.text || (it.formattedOnly ? it.text : '')
      let pdfJudge = null
      // PDF '심판' — 원천(PDF)에서 재추출해 formatted를 검증/교체. 재추출 큐가 기존의 70% 이상이면 채택.
      if (it.pdfFile) {
        upd(idx, { prog: { phase: 'PDF에서 다시 뽑는 중' } })
        try {
          const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(it.pdfFile) })
          const rr = await fetch('/api/pdf-reformat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdfBase64: b64 }) })
          if (rr.ok) {
            const re = await rr.json()
            const oldCues = fmt ? (fmt.match(/^@/gm) || []).length : 0
            const adopt = !fmt || re.cues >= oldCues * 0.7
            if (adopt) fmt = re.formatted
            pdfJudge = { oldCues, newCues: re.cues, adopted: adopt }
          }
        } catch {}
      }
      if (!fmt) { alert('원본이 없어요 — 영어 포맷이나 PDF를 넣어 주세요'); return }
      const scenes = splitScenes(fmt)
      // 1) 진단 — nameMap(인명통일)·toneGuide(말투)·처방
      upd(idx, { prog: { phase: '작품 진단' } })
      let profile = null
      try {
        const headSample = fmt.split('\n').filter(l => l.trim()).slice(0, 40).join('\n').slice(0, 2000)
        const dg = await fetch('/api/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headSample, dialogueSample: buildDialogueSample(scenes.map(t => ({ formatted: t }))), metrics: {}, model }) })
        if (dg.ok) profile = (await dg.json()).profile
      } catch {}
      const register = profile?.toneGuide || ''
      // 2) 씬별 번역
      const out = []
      for (let i = 0; i < scenes.length; i++) {
        upd(idx, { prog: { phase: '재번역', d: i + 1, t: scenes.length } })
        const prevTail = i > 0 ? scenes[i - 1].split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
        try {
          const r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ formattedText: scenes[i], characterMemo: register, guidelines, profile, sceneIndex: i, totalScenes: scenes.length, prevTail, model }) })
          out.push(r.ok ? ((await r.json()).translated || '').trim() : scenes[i])
        } catch { out.push(scenes[i]) }
      }
      const newTr = out.join('\n\n') + '\n'
      download(it.name.replace('.txt', it.formattedOnly ? '_translated.txt' : '_재번역.txt'), newTr)
      // before/after — formattedOnly는 이전 번역본이 없으니(원문=영어) 비교 없이 완료만 표시
      const pairs = []
      let n = scenes.length, changed = 0
      if (!it.formattedOnly) {
        const before = splitScenes(it.text)
        n = Math.min(before.length, out.length)
        for (let i = 0; i < n && pairs.length < 4; i++) if (before[i] !== out[i]) pairs.push({ before: before[i].slice(0, 300), after: out[i].slice(0, 300) })
        changed = before.filter((b, i) => i < n && b !== out[i]).length
      } else {
        changed = n
      }
      upd(idx, { result: { retranslate: true, freshTranslate: !!it.formattedOnly, pairs, total: n, changed, tags: profile ? [profile.weight, profile.latitude].filter(Boolean) : [], pdfJudge } })
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
      {/* 드롭존 — 번역본 넣고 자동 청소 (파일 in → 다운로드 out, 로컬 안 건드림) */}
      {(() => {
        // 넣은 파일을 역할과 함께 전부 나열 (pair면 번역본+영어 포맷 둘 다)
        const roleOf = (name, paired) => paired ? '번역본'
          : /_translated\.txt$/i.test(name) ? '번역본'
          : /_formatted\.txt$/i.test(name) ? '영어 포맷'
          : name.endsWith('.json') ? '수정요청' : '텍스트'
        const baseOf = (name) => name.replace(/_(formatted|translated)\.txt$/i, '').replace(/\.(txt|json)$/i, '')
        const files = []
        for (const it of items) {
          files.push({ name: it.name, base: baseOf(it.name), role: roleOf(it.name, !!it.pairFmt) })
          if (it.pairFmt) files.push({ name: it.pairFmt.name, base: baseOf(it.pairFmt.name), role: '영어 포맷' })
          if (it.pdfFile) files.push({ name: it.pdfFile.name, base: baseOf(it.pdfFile.name), role: '원본 PDF', pdf: true })
        }
        const roleColor = { '번역본': T.accent, '영어 포맷': T.fgMuted, '수정요청': T.warn, '텍스트': T.fgMuted, '원본 PDF': T.good }
        return (
          <div
            onClick={() => ref.current.click()}
            onDragOver={e => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
            style={{ border: `2px dashed ${drag ? T.accent : T.rule}`, boxSizing: 'border-box', borderRadius: 4, minHeight: files.length ? 0 : 110, padding: files.length ? '12px' : '16px', display: 'flex', flexDirection: 'column', alignItems: files.length ? 'stretch' : 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', background: drag ? T.accent + '22' : T.bgCard, marginBottom: 12, transition: 'background .15s, border-color .15s' }}>
            {files.length === 0 ? (
              <>
                <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
                  {['txt', 'json', 'pdf'].map(ext => (
                    <div key={ext} style={{ textAlign: 'center', opacity: 0.3 }}>
                      <DocIcon ext={ext} active={false} />
                      <div style={{ fontSize: 9, color: T.fgDim, marginTop: 5 }}>{ext.toUpperCase()}</div>
                    </div>
                  ))}
                </div>
                <div style={{ color: T.fgDim, fontSize: 12 }}>끌어다 놓거나 클릭</div>
              </>
            ) : (
              <>
                {files.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', background: T.bgInput, borderRadius: 4 }}>
                    <span style={{ flexShrink: 0 }}><DocIcon ext={f.name.endsWith('.json') ? 'json' : f.pdf ? 'pdf' : 'txt'} active={true} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: T.fg, lineHeight: 1.35, wordBreak: 'break-word' }}>{f.base}</div>
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: roleColor[f.role], background: T.chip, padding: '1px 7px', borderRadius: 999, display: 'inline-block', marginTop: 3 }}>{f.role}</span>
                    </div>
                  </div>
                ))}
                {pdfNote && <div style={{ fontSize: 11, color: T.fgDim, textAlign: 'center', lineHeight: 1.5 }}>PDF 원본은 이미 <b style={{ color: T.fgMuted }}>영어 포맷</b>으로 뽑혀 있어요 — 번역본과 같이 넣으면 대조하며 수정돼요</div>}
                <div style={{ color: T.fgDim, fontSize: 12, textAlign: 'center' }}>+ 더 추가하기</div>
              </>
            )}
          </div>
        )
      })()}
      <input ref={ref} type="file" accept=".txt,.json,.pdf" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />

      {/* 변환해둔 작품 골라 재번역 (접힘) — 결과는 로컬에 안 쓰고 파일로 다운로드 */}
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
          s.repeat && `통째로 반복된 단락 ${s.repeat}줄`,
          s.bilingual && `영어+한국어 중복 블록 ${s.bilingual}개`,
          s.headNum && `씬 제목 끝 숫자 ${s.headNum}개`,
          s.spacing && `들쭉날쭉한 줄나눔`,
        ].filter(Boolean)
        const reviewCount = d.dialog.length + d.miscue.length
        const clean = !it.formattedOnly && autoList.length === 0 && s.glued === 0 && reviewCount === 0 && !it.pairFmt   // 영어 짝/원본만 있으면 '깨끗'으로 막지 않음
        return (
          <div key={idx} style={{ background: T.bgCard, borderRadius: 4, marginBottom: 8, overflow: 'hidden' }}>
            <div onClick={() => upd(idx, { open: !it.open })}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer' }}>
              <span style={{ color: T.fg, fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}{it.pairFmt && <span style={{ color: T.accent, fontWeight: 600, fontSize: 11 }}> ＋영어 포맷</span>}</span>
              {it.formattedOnly
                ? <span style={{ fontSize: 12.5, color: T.warn, fontWeight: 600 }}>번역 필요</span>
                : clean
                ? <span style={{ fontSize: 12.5, color: T.good, fontWeight: 600 }}>✓ 깨끗해요</span>
                : <span style={{ fontSize: 12.5, color: T.fgMuted }}>
                    {autoList.length + (s.glued > 0 ? 1 : 0) > 0 && <span style={{ color: T.accent, fontWeight: 600 }}>고칠 것 {autoList.length + (s.glued > 0 ? 1 : 0)}</span>}
                    {reviewCount > 0 && <span style={{ color: T.warn }}>{(autoList.length || s.glued) ? ' · ' : ''}확인 {reviewCount}</span>}
                  </span>}
              <span style={{ color: T.fgDim, fontSize: 12 }}>{it.open ? '▲' : '▼'}</span>
            </div>
            {it.open && (
              <div style={{ borderTop: `1px solid ${T.rule}`, padding: '14px' }}>
                {/* 원본(영어 포맷)만 있고 번역본이 없는 경우 — 새로 번역 대상임을 명시 */}
                {it.formattedOnly && (
                  <div style={{ marginBottom: 12, padding: '12px 13px', background: T.warn + '14', border: `1.5px solid ${T.warn}66`, borderRadius: 6 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: T.warn, marginBottom: 4 }}>번역본이 없어요 — 이 원본을 처음부터 번역해요</div>
                    <div style={{ fontSize: 12, color: T.fgMuted, lineHeight: 1.55 }}>영어 포맷(원본)만 들어왔어요. 아래 <b style={{ color: T.warn }}>제대로 다시 번역</b>을 누르면 진단 → 씬별 번역을 거쳐 완성된 번역본을 내려받아요.</div>
                  </div>
                )}
                {/* 무엇을 고치는지 / 무엇을 확인해야 하는지 상세 */}
                {!it.formattedOnly && !clean && (() => {
                  const lines = it.text.split('\n')
                  const fixItems = [...autoList, s.glued > 0 && `대사에 붙은 지문 ${s.glued}곳 분리`].filter(Boolean)
                  const dialogLines = d.dialog.slice(0, 5).map(i => lines[i]?.trim()).filter(Boolean)
                  const miscueLines = d.miscue.slice(0, 5).map(i => lines[i]?.trim()).filter(Boolean)
                  return (
                    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {fixItems.length > 0 && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, marginBottom: 5 }}>고칠 것 {fixItems.length} <span style={{ fontWeight: 400, color: T.fgDim, fontSize: 11 }}>· 눌러서 자동으로 정리돼요</span></div>
                          {fixItems.map((t, i) => (
                            <div key={i} style={{ fontSize: 12.5, color: T.fgMuted, padding: '1px 0', display: 'flex', gap: 7 }}><span style={{ color: T.accent }}>•</span><span>{t}</span></div>
                          ))}
                        </div>
                      )}
                      {reviewCount > 0 && (
                        <div style={{ padding: '12px 13px', background: T.warn + '14', border: `1.5px solid ${T.warn}66`, borderRadius: 6 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 700, color: T.warn, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>⚠ 자동으로 못 고쳐요 — 사람이 봐야 할 곳 {reviewCount}</div>
                          <div style={{ fontSize: 12, color: T.fgMuted, marginBottom: 10, lineHeight: 1.55 }}>청소(삭제·정리)로는 해결이 안 돼요. 아래는 <b style={{ color: T.warn }}>번역이 덜 됐거나 꼬인 부분</b>이라 <b style={{ color: T.warn }}>재번역</b>이 필요해요.</div>
                          {d.dialog.length > 0 && (
                            <div style={{ marginBottom: dialogLines.length && miscueLines.length ? 8 : 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: T.fg, marginBottom: 3 }}>번역 안 된 영어 줄 {d.dialog.length}</div>
                              {dialogLines.map((t, i) => <div key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: T.fgMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '1px 0' }}>· {t.slice(0, 62)}</div>)}
                              {d.dialog.length > dialogLines.length && <div style={{ fontSize: 11, color: T.fgDim }}>… 외 {d.dialog.length - dialogLines.length}줄</div>}
                            </div>
                          )}
                          {d.miscue.length > 0 && (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: T.fg, marginBottom: 3 }}>큐에 대사·지문이 뭉친 곳 {d.miscue.length}</div>
                              {miscueLines.map((t, i) => <div key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: T.fgMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '1px 0' }}>· {t.slice(0, 62)}</div>)}
                              {d.miscue.length > miscueLines.length && <div style={{ fontSize: 11, color: T.fgDim }}>… 외 {d.miscue.length - miscueLines.length}개</div>}
                            </div>
                          )}
                          <div style={{ fontSize: 11.5, color: T.fgMuted, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.warn}33` }}>→ 아래 <b style={{ color: T.fg }}>제대로 다시 번역</b>{it.pairFmt ? ' 버튼' : ' (영어 포맷도 같이 넣으면 생겨요)'}으로 채워져요. 특정 표현만 손보려면 <b style={{ color: T.fg }}>더 다듬기 · 직접 지시</b>.</div>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* 더 다듬기 — 기존 번역본이 있을 때만 의미 있음(영어 원문엔 말투·지시 적용 대상 없음) */}
                {!it.formattedOnly && (
                  <div style={{ marginBottom: 10, padding: '11px 12px', background: T.bgInput, borderRadius: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.fg, marginBottom: 8 }}>더 다듬기 <span style={{ fontWeight: 400, color: T.fgDim, fontSize: 11 }}>· 선택 (토큰 씀)</span></div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.fg, cursor: 'pointer', marginBottom: 8 }}>
                      <input type="checkbox" checked={it.unify} onChange={e => upd(idx, { unify: e.target.checked })} />
                      말투 통일 <span style={{ color: T.fgDim, fontSize: 12 }}>— 인물별 반말/존댓말 일관되게</span>
                    </label>
                    <input value={it.instr} onChange={e => upd(idx, { instr: e.target.value })} placeholder="직접 지시 (예: 욕설 더 순화 / ○○ 호칭 통일)"
                      style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgCard, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13 }} />
                  </div>
                )}

                {(() => {
                  const retxtRunning = it.running && (it.prog?.phase === '재번역' || it.prog?.phase === '작품 진단' || it.prog?.phase === 'PDF에서 다시 뽑는 중')
                  const cleanRunning = it.running && !retxtRunning
                  const hasSource = !!it.pairFmt || !!it.pdfFile || !!it.formattedOnly   // 재번역 소스(영어 포맷 or PDF or 원본 그 자체)
                  const needsRetrans = reviewCount > 0 || it.formattedOnly              // 미번역·꼬인 큐 있거나 아예 번역본이 없으면 재번역이 근본 해결
                  const retransPrimary = needsRetrans && hasSource
                  const primaryStyle = { width: '100%', padding: '13px', borderRadius: 4, border: 'none', fontWeight: 700, fontSize: 15, cursor: 'pointer' }
                  const btnBg = (on) => on ? { background: T.accent, color: T.accentFg, boxShadow: `0 3px 12px ${T.accent}55` } : { background: T.chip, color: T.fgMuted, boxShadow: 'none' }
                  const cleanDisabled = it.running || (clean && !it.unify && !it.instr.trim())
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* 재번역 — 원본(영어 포맷/PDF/원본단독) 있을 때. 확인(미번역) 있으면 주 액션으로 강조 */}
                      {hasSource && (
                        <button className="sr-press" onClick={() => retranslateDrop(idx)} disabled={it.running}
                          style={{ ...primaryStyle, ...btnBg(retransPrimary && !it.running), cursor: it.running ? 'default' : 'pointer' }}>
                          {retxtRunning || it.prog?.phase === 'PDF에서 다시 뽑는 중' ? `${it.prog.phase} ${it.prog?.t ? `${it.prog.d}/${it.prog.t}` : ''}` : it.formattedOnly ? '✦ 번역하기' : '✦ 제대로 다시 번역'}
                          {!it.running && <span style={{ fontWeight: 400, fontSize: 12 }}> · {it.pdfFile ? 'PDF 검증 후 ' : ''}{it.formattedOnly ? '진단 후 전체 번역' : '전체 재번역'} (토큰)</span>}
                        </button>
                      )}
                      {/* 청소(무료) — 번역본이 있을 때만. 확인 없으면 주 액션 */}
                      {!it.formattedOnly && (
                        <button className="sr-press" onClick={() => applyAll(idx)} disabled={cleanDisabled}
                          style={{ ...primaryStyle, ...btnBg(!retransPrimary && !cleanDisabled), cursor: it.running ? 'default' : 'pointer' }}>
                          {cleanRunning ? `${it.prog?.phase || '처리 중'} ${it.prog?.t ? `${it.prog.d}/${it.prog.t}` : ''}` : clean ? '✓ 깨끗해요' : '✦ 청소해서 저장 (무료)'}
                        </button>
                      )}
                      {needsRetrans && !hasSource && (
                        <div style={{ fontSize: 11, color: T.fgDim, textAlign: 'center' }}>재번역하려면 <b style={{ color: T.fgMuted }}>영어 포맷(_formatted.txt)</b>이나 <b style={{ color: T.fgMuted }}>PDF</b>도 같이 넣어 주세요</div>
                      )}
                    </div>
                  )
                })()}

                {/* 재번역 결과 — 이전→이후 대표 변화 */}
                {it.result?.retranslate && (
                  <div style={{ marginTop: 12, padding: '12px 13px', background: T.bgInput, border: `1px solid ${T.good}55`, borderRadius: 6 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: T.good, marginBottom: 8 }}>
                      {it.result.freshTranslate ? '✓ 번역 완료' : '✓ 다시 번역했어요'}
                      <span style={{ fontWeight: 400, color: T.fgDim, fontSize: 11 }}> · {it.result.freshTranslate ? `${it.result.total}씬` : `바뀐 씬 ${it.result.changed}/${it.result.total}`}{it.result.tags?.length ? ` · ${it.result.tags.join('·')}` : ''}</span>
                    </div>
                    {it.result.pdfJudge && (
                      <div style={{ fontSize: 11.5, color: T.fgMuted, marginBottom: 8, padding: '6px 9px', background: T.chip, borderRadius: 4 }}>
                        <b style={{ color: T.fg }}>PDF 심판</b> · 원본 재추출 큐 {it.result.pdfJudge.oldCues}→{it.result.pdfJudge.newCues} — {it.result.pdfJudge.adopted ? 'PDF에서 뽑은 걸 소스로 채택 (formatted보다 안 나쁨)' : 'PDF 재추출이 더 부실해 기존 formatted 유지'}
                      </div>
                    )}
                    {it.result.pairs.map((p, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: i < it.result.pairs.length - 1 ? 10 : 0 }}>
                        <div>
                          <div style={{ fontSize: 10, color: T.fgDim, marginBottom: 3 }}>이전</div>
                          <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55, color: T.fgMuted, borderLeft: `2px solid ${T.err}`, paddingLeft: 7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.before}</pre>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: T.good, marginBottom: 3 }}>이후</div>
                          <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55, color: T.fg, borderLeft: `2px solid ${T.good}`, paddingLeft: 7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.after}</pre>
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: T.fgDim, marginTop: 10 }}>_재번역.txt로 받았어요. 공유폴더에 넣으면 리더에 반영돼요.</div>
                  </div>
                )}

                {/* 결과 — 이렇게 손봤어요 (청소 diff, LLM 0) */}
                {it.result && !it.result.retranslate && (() => {
                  const r = it.result
                  const badges = [
                    r.counts.meta && `AI 군말 ${r.counts.meta}`,
                    r.counts.boiler && `머리말·꼬리말 ${r.counts.boiler}`,
                    r.counts.dupe && `겹친 줄 ${r.counts.dupe}`,
                    r.counts.repeat && `반복 단락 ${r.counts.repeat}줄`,
                    r.counts.bilingual && `영한 중복 ${r.counts.bilingual}`,
                    r.counts.headNum && `씬번호 ${r.counts.headNum}`,
                    r.beforeLines !== r.afterLines && `줄나눔 ${r.beforeLines}→${r.afterLines}줄`,
                    r.aiUnify && '말투 통일',
                    r.aiInstr && `지시: ${r.aiInstr.slice(0, 12)}`,
                  ].filter(Boolean)
                  return (
                    <div style={{ marginTop: 12, padding: '12px 13px', background: T.bgInput, border: `1px solid ${T.good}55`, borderRadius: 6 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.good, marginBottom: 8 }}>✓ 이렇게 손봤어요</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: r.removed.length || r.joins.length ? 10 : 0 }}>
                        {badges.length ? badges.map((b, i) => (
                          <span key={i} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: T.chip, color: T.fgMuted }}>{b}</span>
                        )) : <span style={{ fontSize: 12, color: T.fgDim }}>바뀐 게 거의 없어요</span>}
                      </div>
                      {r.joins.map((j, i) => (
                        <div key={'j' + i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
                          <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.fgDim, borderLeft: `2px solid ${T.err}`, paddingLeft: 7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{j.before.slice(0, 90)}</div>
                          <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.fg, borderLeft: `2px solid ${T.good}`, paddingLeft: 7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{j.after.slice(0, 90)}</div>
                        </div>
                      ))}
                      {r.removed.length > 0 && (
                        <div style={{ marginTop: r.joins.length ? 8 : 0 }}>
                          <div style={{ fontSize: 11, color: T.fgDim, marginBottom: 4 }}>빠진 줄 {r.removedTotal > r.removed.length ? `(대표 ${r.removed.length}/${r.removedTotal})` : ''}</div>
                          {r.removed.map((rm, i) => (
                            <div key={'r' + i} style={{ fontSize: 11, fontFamily: 'monospace', color: T.fgMuted, padding: '1px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              <span style={{ color: T.fgDim }}>[{rm.kind}]</span> <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{rm.text.slice(0, 60)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: T.fgDim, marginTop: 10 }}>더 고치려면 위 <b>더 다듬기</b>에 조건 넣고 다시 실행하면 여기 새로 반영돼요.</div>
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        )
      })}

      {items.length === 0 && (
        <div style={{ marginTop: 20 }}>
          {/* 칩 — 누르면 예시 펼침 */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'center' }}>
            {Object.keys(PILL_EX).map(t => {
              const on = exPill === t
              return (
                <span key={t} onClick={() => setExPill(on ? null : t)}
                  style={{ fontSize: 11.5, color: on ? T.accentFg : T.fgMuted, background: on ? T.accent : T.chip, padding: '5px 12px', borderRadius: 999, cursor: 'pointer', transition: 'background .12s, color .12s', userSelect: 'none' }}>{t}</span>
              )
            })}
          </div>

          {/* 선택된 칩 예시 (before → after) */}
          {exPill && (() => {
            const ex = PILL_EX[exPill]
            const cell = (label, txt, color) => (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10.5, color: T.fgDim, marginBottom: 4 }}>{label}</div>
                <pre style={{ margin: 0, padding: '8px 10px', background: T.bgInput, border: `1px solid ${T.rule}`, borderLeft: `2px solid ${color}`, borderRadius: 3, fontSize: 11, lineHeight: 1.5, color: T.fgMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{txt}</pre>
              </div>
            )
            return (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {cell('이전', ex.before, T.err)}
                <div style={{ alignSelf: 'center', color: T.fgDim, fontSize: 13 }}>→</div>
                {cell('이후', ex.after, T.good)}
              </div>
            )
          })()}

          {/* 설명 — 맨 아래 */}
          <div style={{ color: T.fgMuted, fontSize: 13, textAlign: 'center', marginTop: 18 }}>
            번역본을 넣으면 <b style={{ color: T.fg }}>군말·중복·줄나눔</b>을 자동으로 정리해요
          </div>
        </div>
      )}
    </div>
  )
}

// ── 재번역(개선) 헬퍼 ───────────────────────────────
const FLAG_KO = { songs: '노래', narration: '내레이션', heavy_credits: '크레딧', famous: '유명작', period: '시대극', stylized: '강한문체', foreign_mix: '외국어혼재', profanity: '욕설강', epistolary: '문어체', jargon: '전문용어', family: '가족' }
const WEIGHT_KO = { dialogue: '대사형', description: '지문형', mixed: '혼합' }
const LATITUDE_KO = { tight: '충실', balanced: '균형', loose: '여유' }
function fmtAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(diff / 3600000)
  if (hr < 24) return `${hr}시간 전`          // 24시간 이내는 시간으로
  const dd = Math.floor(diff / 86400000)
  if (dd < 7) return `${dd}일 전`
  const d = new Date(ts)
  return `${d.getMonth() + 1}.${d.getDate()}`
}
function parseProg(log = []) {
  let done = 0, total = 0, failed = 0
  for (const ln of log) {
    let m = ln.match(/(\d+)\/(\d+)\s*\(실패\s*(\d+)\)/)
    if (m) { done = +m[1]; total = +m[2]; failed = +m[3]; continue }
    m = ln.match(/번역 시작:\s*(\d+)\s*씬/); if (m && !total) total = +m[1]
    m = ln.match(/__SCENES__\s*(\d+)/); if (m && !total) total = +m[1]
  }
  return { done, total, failed }
}
// 결과 다운로드 — 서버 /tmp의 재번역본을 받음(로컬 작품폴더는 안 건드림). 파일 없으면 안내.
async function downloadResult(w) {
  try {
    const r = await fetch(`/api/reprocess-result?work=${encodeURIComponent(w)}`)
    if (!r.ok) { alert('결과 파일이 없어요 — 예전 기록이거나 서버 재시작으로 사라졌어요. 다시 개선해 주세요.'); return }
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${w}_translated.txt`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  } catch (e) { alert('다운로드 실패: ' + e.message) }
}

// 변환해둔 작품 골라 재번역 — 결과는 로컬에 안 쓰고 파일로 다운로드. 접힘(편의 단축, 동료는 목록 비어있어도 무해).
function ReprocessSection() {
  const [works, setWorks] = useState([])
  const [work, setWork] = useState('')
  const [instr, setInstr] = useState('')
  const [st, setSt] = useState(null)
  const [open, setOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)
  useEffect(() => {
    fetch('/api/works').then(r => r.json()).then(d => setWorks(d.works || [])).catch(() => {})
    fetch('/api/reprocess-status').then(r => r.json()).then(s => {
      if (s?.running) { setSt(s); setOpen(true) } else setSt({ history: s?.history || [] })
    }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!st?.running) return
    const t = setInterval(async () => { try { setSt(await (await fetch('/api/reprocess-status')).json()) } catch {} }, 1500)
    return () => clearInterval(t)
  }, [st?.running])
  async function start(workArg) {
    const w = (typeof workArg === 'string' && workArg) ? workArg : work
    if (!w) return
    try {
      const autoGo = !!loadSettings().reprocAutoGo
      const r = await fetch('/api/reprocess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work: w, instruction: instr.trim(), autoGo }) })
      if (!r.ok) { alert('시작 실패: ' + (await r.text())); return }
      const j = await r.json().catch(() => ({}))
      setWork(''); setInstr('')
      if (j.queued) { if (!j.dup) setSt(s => ({ ...(s || {}), queue: [...((s && s.queue) || []), w] })) }
      else setSt({ running: true, work: w, log: [], done: false, phase: 'diagnosing', queue: (st && st.queue) || [] })
    } catch (e) { alert('시작 실패: ' + e.message) }
  }
  async function removeQueue(w) {
    try { const r = await fetch('/api/reprocess-queue-remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work: w }) }); const j = await r.json(); setSt(s => ({ ...(s || {}), queue: j.queue || [] })) } catch (e) { alert(e.message) }
  }
  async function go() { try { await fetch('/api/reprocess-go', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setSt(s => ({ ...s, phase: 'translating' })) } catch (e) { alert(e.message) } }
  async function stop() { try { await fetch('/api/reprocess-stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setSt(s => ({ ...(s || {}), running: false, done: true, phase: 'stopped' })) } catch (e) { alert(e.message) } }
  async function resume(w) {
    try {
      const r = await fetch('/api/reprocess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work: w, resume: true }) })
      if (!r.ok) { alert('이어하기 실패: ' + (await r.text())); return }
      setSt({ running: true, work: w, log: ['이어하기…'], done: false, phase: 'translating' })
    } catch (e) { alert(e.message) }
  }
  const awaiting = st?.phase === 'awaiting_go'
  const busy = st?.running
  const histAt = {}
  for (const h of (st?.history || [])) if (h.work && h.at && !histAt[h.work]) histAt[h.work] = h.at
  const bdg = (txt, color) => <span style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: T.chip, color: color || T.fgMuted, whiteSpace: 'nowrap' }}>{txt}</span>
  const ctrlBtn = { padding: '6px 13px', borderRadius: 3, background: T.chip, border: 'none', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }

  return (
    <div style={{ border: `1px solid ${T.rule}`, borderRadius: 6, marginTop: 16, overflow: 'hidden' }}>
      <div onClick={() => setOpen(v => !v)} className="sr-press" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', cursor: 'pointer' }}>
        <span style={{ color: T.fgMuted, fontSize: 13, fontWeight: 600, flex: 1 }}>변환해둔 작품 골라 재번역 <span style={{ color: T.fgDim, fontWeight: 400, fontSize: 11.5 }}>· 결과는 파일로 받기</span></span>
        {busy && <span style={{ fontSize: 12, color: T.accent }}>진행 중…</span>}
        <span style={{ color: T.fgDim, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${T.rule}`, padding: 14 }}>
          <select value={work} onChange={e => setWork(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13, marginBottom: 8 }}>
            <option value="">작품 선택…</option>
            {works.map(w => <option key={w} value={w}>{w}{histAt[w] ? ` — ${fmtAgo(histAt[w])} 수정함` : ''}</option>)}
          </select>
          <input value={instr} onChange={e => setInstr(e.target.value)} placeholder="(선택) 수정 지시 — 예: 욕설 더 순화 / ○○ 호칭 통일"
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 13, marginBottom: 10 }} />
          <button className="sr-press" onClick={start} disabled={!work}
            style={{ width: '100%', padding: '12px', borderRadius: 4, border: 'none', background: !work ? T.chip : T.accent, color: !work ? T.fgDim : T.accentFg, fontWeight: 700, fontSize: 14.5, cursor: !work ? 'default' : 'pointer', boxShadow: !work ? 'none' : `0 3px 12px ${T.accent}55` }}>
            {busy ? '＋ 대기열에 추가' : '개선하기'}
          </button>
          {busy
            ? <div style={{ fontSize: 11, color: T.fgDim, textAlign: 'center', marginTop: 6 }}>진행 중 — 고른 작품은 끝나면 자동으로 이어서 시작해요</div>
            : <div style={{ fontSize: 11, color: T.fgDim, textAlign: 'center', marginTop: 6 }}>진단 → 재번역, 끝나면 <b style={{ color: T.fgMuted }}>파일로 다운로드</b> (로컬엔 안 써요)</div>}

          {/* 진단 후 대기 — 게이트 */}
          {awaiting && st.profile && (() => {
            const imps = st.profile.improvements?.length ? st.profile.improvements : null
            return (
              <div style={{ marginTop: 14, border: `1px solid ${T.accent}55`, borderRadius: 6, padding: 14, background: T.accent + '0d' }}>
                {st.sourceIssues?.length > 0 && (
                  <div style={{ marginBottom: 10, padding: 10, borderRadius: 4, background: T.err + '14', border: `1px solid ${T.err}44` }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.err, marginBottom: 3 }}>⚠ 소스(원본)에 문제가 있어요</div>
                    {st.sourceIssues.map((t, i) => <div key={i} style={{ fontSize: 12, color: T.fgMuted }}>· {t}</div>)}
                    <div style={{ fontSize: 11, color: T.fgDim, marginTop: 4 }}>재번역해도 깨질 가능성이 커요. 깨끗한 PDF를 권해요.</div>
                  </div>
                )}
                <div style={{ fontSize: 12.5, fontWeight: 700, color: T.fg, marginBottom: 8 }}>{imps ? '이렇게 좋아져요' : '딱히 손볼 큰 문제는 없어요'}</div>
                {imps
                  ? imps.map((t, i) => <div key={i} style={{ fontSize: 13, color: T.fgMuted, padding: '2px 0', display: 'flex', gap: 7 }}><span style={{ color: T.accent }}>✦</span><span>{t}</span></div>)
                  : <div style={{ fontSize: 13, color: T.fgMuted }}>그래도 새 처방으로 다시 번역하면 조금 더 다듬어질 수 있어요.</div>}
                <button className="sr-press" onClick={go}
                  style={{ width: '100%', marginTop: 12, padding: '13px', borderRadius: 4, border: 'none', background: T.accent, color: T.accentFg, fontWeight: 700, fontSize: 15, cursor: 'pointer', boxShadow: `0 3px 12px ${T.accent}66` }}>
                  {imps ? '이대로 고치기' : '그래도 다시 번역하기'} <span style={{ fontWeight: 400, fontSize: 13 }}>· 약 {st.estMin}분</span>
                </button>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: T.fgDim }}>{st.sceneCount}씬 다시 번역해요</span>
                  <span style={{ color: T.rule }}>·</span>
                  <button className="sr-press" onClick={stop}
                    style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 12, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>취소</button>
                </div>
              </div>
            )
          })()}

          {/* 진행/완료 — 변환과 같은 시각 언어 + 완료 시 다운로드 */}
          {st && !awaiting && (st.running || st.done || st.error) && (() => {
            const { done, total, failed } = parseProg(st.log)
            const diagnosing = st.phase === 'diagnosing'
            const stopped = st.phase === 'stopped'
            const finished = st.done && !stopped && !st.error
            const pct = total > 0 ? Math.round((done / total) * 100) : (finished ? 100 : 0)
            const barColor = st.error ? T.err : finished ? (failed > 0 ? T.err : T.good) : stopped ? T.fgMuted : T.warn
            const phaseLabel = st.error ? '실패' : stopped ? '중단됨' : finished ? '완료' : diagnosing ? '작품 진단 중' : '번역 중'
            const p = st.profile, imps = p?.improvements?.length ? p.improvements : null
            const tags = p ? [WEIGHT_KO[p.weight], LATITUDE_KO[p.latitude], ...(p.flags || []).map(f => FLAG_KO[f] || f)].filter(Boolean) : []
            return (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                  <span style={{ color: T.fg, fontSize: 15, fontWeight: 700 }}>{st.work}</span>
                  {total > 0 && <span style={{ color: T.fgMuted, fontSize: 12.5 }}>{done}/{total} 씬</span>}
                  <span style={{ color: st.error ? T.err : finished ? T.good : stopped ? T.fgDim : T.warn, fontSize: 12, fontWeight: 600 }}>{phaseLabel}</span>
                </div>
                <div style={{ height: 6, background: T.rule, borderRadius: 3, marginBottom: 8, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, width: `${pct}%`, background: barColor, transition: 'width .3s', animation: diagnosing ? 'pulse 1.2s ease-in-out infinite' : 'none' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: finished || st.error ? 10 : 0 }}>
                  {total > 0 && bdg(`${pct}%`)}
                  {failed > 0 && bdg(`실패 ${failed}`, T.err)}
                  <span style={{ flex: 1 }} />
                  {st.running && <button className="sr-press" onClick={stop} style={{ ...ctrlBtn, color: T.err }}>중단</button>}
                  {st.error && !st.running && <button className="sr-press" onClick={() => start(st.work)} style={{ ...ctrlBtn, color: T.accent }}>다시 시도</button>}
                  {(stopped || st.error) && !st.running && <button className="sr-press" onClick={() => resume(st.work)} style={{ ...ctrlBtn, color: T.accent }}>이어하기</button>}
                </div>
                {(finished || st.error) && (() => {
                  const qIssues = st.qualityIssues || []
                  const broken = finished && qIssues.length > 0   // 결과가 깨짐 → '완료'로 안 내보냄
                  return (
                  <div style={{ borderRadius: 3, overflow: 'hidden', background: T.chip }}>
                    <div style={{ padding: '11px 14px', color: st.error || broken ? T.err : failed > 0 ? T.err : T.good, fontWeight: 700, fontSize: 14 }}>
                      {st.error ? '개선 실패 — Claude 서버 과부하일 수 있어요' : broken ? '⚠ 완료했지만 결과 품질에 문제가 있어요' : failed > 0 ? `개선 완료 — 실패 ${failed}씬` : '개선 완료 ✓'}
                    </div>
                    {!st.error && broken && (
                      <div style={{ padding: '0 14px 12px', fontSize: 13, color: T.fgMuted, lineHeight: 1.7 }}>
                        {qIssues.map((t, i) => <div key={i} style={{ display: 'flex', gap: 7, padding: '1px 0' }}><span style={{ color: T.err }}>•</span><span>{t}</span></div>)}
                        <div style={{ marginTop: 8 }}>원본(PDF·소스)이 오염됐을 가능성이 커요. <b style={{ color: T.fgMuted }}>이대로 받으면 리더가 깨져요</b> — 깨끗한 PDF로 다시 받거나 소스를 손본 뒤 재번역하세요.</div>
                        <button className="sr-press" onClick={() => downloadResult(st.work)} style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 12, cursor: 'pointer', marginTop: 8, padding: 0, textDecoration: 'underline' }}>그래도 받기</button>
                      </div>
                    )}
                    {!st.error && !broken && (
                      <div style={{ padding: '0 14px 12px', fontSize: 13, color: T.fgMuted, lineHeight: 1.8 }}>
                        {imps && <div style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.fg, marginBottom: 3 }}>이렇게 손봤어요</div>
                          {imps.map((t, i) => <div key={i} style={{ display: 'flex', gap: 7, padding: '1px 0' }}><span style={{ color: T.good }}>✦</span><span>{t}</span></div>)}
                        </div>}
                        {tags.length > 0 && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: T.fgDim, fontWeight: 700, alignSelf: 'center' }}>진단</span>
                          {tags.map((t, i) => <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: T.chip, color: T.fgMuted }}>{t}</span>)}
                        </div>}
                        {st.diff?.pairs?.length > 0 && (
                          <div style={{ marginBottom: 10, padding: '10px 12px', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 6 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: T.fg, marginBottom: 8 }}>이전 → 이후 <span style={{ fontWeight: 400, color: T.fgDim, fontSize: 11 }}>· 바뀐 씬 {st.diff.changed}/{st.diff.total}, 대표 {st.diff.pairs.length}개</span></div>
                            {st.diff.pairs.map((p, i) => (
                              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: i < st.diff.pairs.length - 1 ? 10 : 0 }}>
                                <div>
                                  <div style={{ fontSize: 10, color: T.fgDim, marginBottom: 3 }}>이전</div>
                                  <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55, color: T.fgMuted, borderLeft: `2px solid ${T.err}`, paddingLeft: 7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.before}</pre>
                                </div>
                                <div>
                                  <div style={{ fontSize: 10, color: T.good, marginBottom: 3 }}>이후</div>
                                  <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55, color: T.fg, borderLeft: `2px solid ${T.good}`, paddingLeft: 7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.after}</pre>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        <div><span style={{ color: T.good }}>· 씬 {done}/{total} 다시 번역됨</span></div>
                        <button className="sr-press" onClick={() => downloadResult(st.work)}
                          style={{ width: '100%', marginTop: 10, padding: '12px', borderRadius: 4, border: 'none', background: T.accent, color: T.accentFg, fontWeight: 700, fontSize: 14, cursor: 'pointer', boxShadow: `0 3px 12px ${T.accent}55` }}>
                          ✦ 번역본 다운로드 (.txt)
                        </button>
                        <div style={{ fontSize: 11, color: T.fgDim, marginTop: 6 }}>받아서 공유폴더에 넣으면 돼요 — 로컬 작품 폴더는 안 건드려요.</div>
                      </div>
                    )}
                    {st.error && <div style={{ padding: '0 14px 11px', fontSize: 13, color: T.fgMuted }}>잠시 후 「다시 시도」 또는 「이어하기」를 눌러주세요.</div>}
                  </div>
                  )
                })()}
                <button onClick={() => setShowLog(v => !v)} style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 11.5, cursor: 'pointer', marginTop: 8, padding: 0 }}>자세히 {showLog ? '▲' : '▾'}</button>
                {showLog && <pre style={{ margin: '6px 0 0', maxHeight: 180, overflowY: 'auto', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, padding: 10, fontSize: 11, lineHeight: 1.5, color: T.fgMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{(st.log || []).slice(-20).join('\n') || '시작 중…'}</pre>}
              </div>
            )
          })()}

          {/* 대기열 */}
          {st?.queue?.length > 0 && (
            <div style={{ marginTop: 14, borderTop: `1px solid ${T.rule}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: T.fgDim, fontWeight: 700, marginBottom: 6 }}>대기열 {st.queue.length} <span style={{ fontWeight: 400 }}>· 하나씩 자동 진행</span></div>
              {st.queue.map((w, i) => (
                <div key={w} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: T.fgMuted, padding: '3px 0' }}>
                  <span style={{ color: T.fgDim, width: 14, textAlign: 'right' }}>{i + 1}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w}</span>
                  <button onClick={() => removeQueue(w)} title="대기열에서 빼기" style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 14, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* 최근 기록 — done은 다운로드, 중단/실패는 이어하기 */}
          {st?.history?.length > 0 && (
            <div style={{ marginTop: 14, borderTop: `1px solid ${T.rule}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: T.fgDim, fontWeight: 700, marginBottom: 6 }}>최근</div>
              {st.history.map((h, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: T.fgMuted, padding: '3px 0' }}>
                  <span style={{ color: h.status === 'done' ? T.good : h.status === 'stopped' ? T.fgDim : T.err }}>{h.status === 'done' ? '✓' : h.status === 'stopped' ? '■' : '✕'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.work}</span>
                  {h.at && <span style={{ color: T.fgDim, fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmtAgo(h.at)}</span>}
                  {h.status === 'done' && (h.hasResult
                    ? <button onClick={() => downloadResult(h.work)} style={{ padding: '3px 10px', borderRadius: 3, border: `1px solid ${T.accent}`, background: 'none', color: T.accent, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>다운로드</button>
                    : <span style={{ fontSize: 11, color: T.fgDim }}>받음</span>)}
                  {(h.status === 'stopped' || h.status === 'error') && !busy && <button onClick={() => resume(h.work)} style={{ padding: '3px 10px', borderRadius: 3, border: `1px solid ${T.accent}`, background: 'none', color: T.accent, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>이어하기</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

