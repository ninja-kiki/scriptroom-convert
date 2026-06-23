// 작품 프로파일러 1단계 — 진단 패스(출력만, 변환 안 건드림).
//   node tools/diagnose.mjs <작품폴더> [<작품2> ...]   # 각 작품 진단 프로파일 출력
// 로컬 측정치 + 본문/대사/자막 샘플 → /api/diagnose(서버) → 프로파일 JSON.
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const MODEL = 'claude-opus-4-8'
const works = process.argv.slice(2)
if (!works.length) { console.error('사용: node tools/diagnose.mjs <작품폴더> [..]'); process.exit(1) }

// ── 로컬 측정 (공짜·결정적) ──────────────────────────────
function metricsOf(en) {
  const lines = en.replace(/\r/g, '').split('\n')
  const nonEmpty = lines.filter(l => l.trim())
  const cues = lines.filter(l => /^@/.test(l))
  const brokenCues = cues.filter(l => /^@[^A-Z가-힣]/.test(l))
  const noise = nonEmpty.filter(l => /[\^~|\\]|\/\s?[a-z]\s?\/|^[\W_]{2,}$/.test(l) && !/[가-힣]{2,}|[A-Za-z]{4,}/.test(l))
  const scenes = lines.filter(l => /^#\s/.test(l))
  const credits = lines.filter(l => /\[(크레딧|credit|super|삽입)/i.test(l))
  // 대사 vs 지문: @큐 다음 줄=대사, 그 외 본문=지문 (대략)
  let dlg = 0, act = 0, actWords = 0, afterCue = false, sawDlg = false
  for (const l of lines) {
    const t = l.trim()
    if (/^@/.test(t)) { afterCue = true; sawDlg = false; continue }   // 큐 → 대사 모드
    if (/^#/.test(t)) { afterCue = false; continue }
    if (t === '') { if (sawDlg) afterCue = false; continue }           // 빈 줄: 대사 본 뒤에만 모드 종료(큐 직후 빈 줄은 유지)
    if (/^\(/.test(t)) continue
    if (afterCue) { dlg++; sawDlg = true }
    else { act++; actWords += t.split(/\s+/).length }
  }
  const total = nonEmpty.length || 1
  return {
    scenes: scenes.length,
    cues: cues.length,
    brokenCueRatio: cues.length ? +(brokenCues.length / cues.length).toFixed(2) : 0,
    noiseRatio: +(noise.length / total).toFixed(3),
    dialogueLines: dlg, actionLines: act,
    dialogueRatio: (dlg + act) ? +(dlg / (dlg + act)).toFixed(2) : 0,
    avgActionWords: act ? +(actWords / act).toFixed(1) : 0,
    creditLines: credits.length,
    sourceGuess: (noise.length / total > 0.01 || (cues.length && brokenCues.length / cues.length > 0.03)) ? 'scan' : 'digital',
  }
}

function headSample(en, n = 40) {
  return en.replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(0, n).join('\n').slice(0, 2000)
}
function dialogueSample(en, maxChars = 3500) {
  const lines = en.split('\n'); const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^@/.test(lines[i])) continue
    const cue = lines[i].replace(/^@/, '').split('(')[0].trim()
    let j = i + 1; while (j < lines.length && (lines[j].trim() === '' || /^\(/.test(lines[j].trim()))) j++
    const dlg = (lines[j] || '').trim()
    if (cue && dlg && !/^[#@]/.test(dlg)) out.push(`${cue}: ${dlg.slice(0, 70)}`)
  }
  const step = Math.max(1, Math.floor(out.length / 80))
  const s = []; let len = 0
  for (let i = 0; i < out.length; i += step) { if (len + out[i].length > maxChars) break; s.push(out[i]); len += out[i].length }
  return s.join('\n')
}
function subSample(raw, maxChars = 2500, cap = 80) {
  const lines = raw.replace(/\r/g, '').replace(/<[^>]+>/g, '\n').split('\n').map(l => l.trim())
    .filter(l => l && !/^\d+$/.test(l) && !/-->/.test(l) && /[가-힣]/.test(l))
  const seen = new Set(), uniq = []
  for (const l of lines) if (!seen.has(l)) { seen.add(l); uniq.push(l) }
  const step = Math.max(1, Math.floor(uniq.length / cap)); const s = []; let len = 0
  for (let i = 0; i < uniq.length; i += step) { if (len + uniq[i].length > maxChars) break; s.push(uniq[i]); len += uniq[i].length }
  return s.join('\n')
}

try { const h = await (await fetch(`${SERVER}/api/health`)).json(); if (!h.ok || !h.claude) { console.error('서버/Claude 준비 안 됨'); process.exit(1) } }
catch { console.error(`서버(${SERVER}) 연결 실패`); process.exit(1) }

for (const work of works) {
  const dir = join(CONTENT, work)
  if (!existsSync(dir)) { console.log(`\n[${work}] 폴더 없음`); continue }
  const files = readdirSync(dir)
  const ff = files.find(f => /_formatted\.txt$/.test(f))
  if (!ff) { console.log(`\n[${work}] _formatted 없음`); continue }
  const en = readFileSync(join(dir, ff), 'utf8')
  const subF = files.find(f => /KR\.(srt|smi)$/i.test(f)) || files.find(f => /\.(srt|smi)$/i.test(f) && /kr|ko|한/i.test(f))
  const m = metricsOf(en)
  const res = await (await fetch(`${SERVER}/api/diagnose`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      headSample: headSample(en), dialogueSample: dialogueSample(en),
      subtitleSample: subF ? subSample(readFileSync(join(dir, subF), 'utf8')) : '',
      metrics: m, model: MODEL,
    }),
  })).json()
  const p = res.profile
  console.log(`\n══════ ${work} ══════`)
  console.log(`측정: 씬${m.scenes} 큐${m.cues} 대사비율${m.dialogueRatio} 평균지문${m.avgActionWords}단어 노이즈${m.noiseRatio} 소스추정=${m.sourceGuess}${subF ? ' ·자막O' : ''}`)
  if (!p) { console.log('진단 파싱 실패:', res.raw); continue }
  console.log(`진단: 무게=${p.weight} · 말투=${p.register} · 자유도=${p.latitude} · 플래그=[${(p.flags || []).join(', ')}]`)
  console.log(`줄거리: ${p.synopsis}`)
  console.log(`관계: ${p.relations}`)
  if (p.notes) console.log(`특이: ${p.notes}`)
}
