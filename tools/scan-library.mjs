// 라이브러리 전수 로컬 스캔(공짜·LLM 없음) — 소스타입·무게중심·노래/크레딧 플래그 분포.
// node tools/scan-library.mjs
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'
const DIR = '/Users/hojun/Projects/scriptroom/content'

function metrics(en) {
  const lines = en.replace(/\r/g, '').split('\n'); const ne = lines.filter(l => l.trim())
  const cues = lines.filter(l => /^@/.test(l)); const broken = cues.filter(l => /^@[^A-Z가-힣]/.test(l))
  const noise = ne.filter(l => /[\^~|\\]/.test(l) && !/[가-힣]{2,}|[A-Za-z]{4,}/.test(l))
  let dlg = 0, act = 0, aw = 0, after = false, saw = false
  for (const l of lines) { const t = l.trim()
    if (/^@/.test(t)) { after = true; saw = false; continue }
    if (/^#/.test(t)) { after = false; continue }
    if (t === '') { if (saw) after = false; continue }
    if (/^\(/.test(t)) continue
    if (after) { dlg++; saw = true } else { act++; aw += t.split(/\s+/).length } }
  const songs = (en.match(/\b(sings?|singing|song)\b/gi) || []).length + (en.match(/노래(를|한다|해|하)/g) || []).length
  const credits = (en.match(/\[(크레딧|credit|super|삽입)/gi) || []).length
  return {
    scenes: lines.filter(l => /^#\s/.test(l)).length, cues: cues.length,
    brokenR: cues.length ? broken.length / cues.length : 0,
    noiseR: noise.length / (ne.length || 1),
    dlgR: (dlg + act) ? dlg / (dlg + act) : 0, avgAct: act ? aw / act : 0,
    songs, credits,
  }
}
const works = readdirSync(DIR).filter(w => { try { return statSync(join(DIR, w)).isDirectory() } catch { return false } })
const rows = []
for (const w of works) {
  const dir = join(DIR, w); let ff
  try { ff = readdirSync(dir).find(f => /_formatted\.txt$/.test(f)) } catch { continue }
  if (!ff) continue
  const m = metrics(readFileSync(join(dir, ff), 'utf8'))
  const source = (m.noiseR > 0.01 || m.brokenR > 0.03) ? 'scan' : 'digital'
  const weight = m.dlgR >= 0.65 ? 'dialogue' : m.dlgR <= 0.45 ? 'description' : 'mixed'
  const flags = []
  if (m.songs >= 4) flags.push('songs')
  if (m.credits >= 8) flags.push('credits')
  rows.push({ w, source, weight, flags, ...m })
}
const cnt = (key, val) => rows.filter(r => Array.isArray(r[key]) ? r[key].includes(val) : r[key] === val).length
console.log(`\n총 ${rows.length}편 스캔\n`)
console.log(`[소스]  digital ${cnt('source','digital')} · scan ${cnt('source','scan')}`)
console.log(`[무게]  대사형 ${cnt('weight','dialogue')} · 혼합 ${cnt('weight','mixed')} · 지문형 ${cnt('weight','description')}`)
console.log(`[플래그] 노래 ${cnt('flags','songs')} · 크레딧多 ${cnt('flags','credits')}`)
console.log(`\n노래(songs) 후보: ${rows.filter(r => r.flags.includes('songs')).map(r => r.w).join(', ') || '없음'}`)
console.log(`스캔(scan) 의심: ${rows.filter(r => r.source === 'scan').map(r => r.w).join(', ') || '없음'}`)
console.log(`지문형(description): ${rows.filter(r => r.weight === 'description').map(r => r.w).join(', ') || '없음'}`)
