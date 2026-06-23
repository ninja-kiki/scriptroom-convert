// 청소된 _formatted.txt를 '가이드-온리' 새 흐름으로 재번역.
//   node tools/retranslate.mjs <작품폴더명> --guide       # 가이드만 생성·출력 (확인용)
//   node tools/retranslate.mjs <작품폴더명> --write        # 가이드 생성 후 전 씬 번역 → _translated.txt 덮어쓰기(.retbak)
// 서버(3001) 필요. 자막(KR srt/smi)이 있으면 말투·관계 가이드 근거로 씀. 번역엔 자막을 직접 안 넣음.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const MODEL = 'claude-opus-4-8'
const work = process.argv[2]
const GUIDE_ONLY = process.argv.includes('--guide')
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/retranslate.mjs <작품폴더> --guide|--write'); process.exit(1) }

const dir = join(CONTENT, work)
const files = readdirSync(dir)
const fmtFile = files.find(f => /_formatted\.txt$/.test(f))
const trFile = files.find(f => /_translated\.txt$/.test(f))
const subFile = files.find(f => /KR\.(srt|smi)$/i.test(f)) || files.find(f => /\.(srt|smi)$/i.test(f) && /kr|ko|한/i.test(f)) || files.find(f => /\.(srt|smi)$/i.test(f))  // 마지막 fallback: 아무 자막이나(한글 없으면 subtitleSample이 비워 무시)
if (!fmtFile) { console.error('_formatted.txt 없음'); process.exit(1) }
const enText = readFileSync(join(dir, fmtFile), 'utf8').replace(/\r/g, '')

// 씬 분할: # 헤딩 기준
function splitScenes(text) {
  const lines = text.split('\n')
  const scenes = []; let cur = []
  for (const l of lines) {
    if (/^#\s/.test(l) && cur.length) { scenes.push(cur.join('\n').trim()); cur = [] }
    cur.push(l)
  }
  if (cur.length) scenes.push(cur.join('\n').trim())
  return scenes.filter(Boolean)
}

// 대사 샘플: @큐 + 그 다음 첫 대사 줄을 작품 전반에서 고르게
function buildDialogueSample(text, maxChars = 4000) {
  const lines = text.split('\n'); const pairs = []
  for (let i = 0; i < lines.length; i++) {
    if (/^@/.test(lines[i])) {
      const cue = lines[i].replace(/^@/, '').split('(')[0].trim()
      let j = i + 1; while (j < lines.length && lines[j].trim() === '') j++
      const dlg = (lines[j] || '').trim()
      if (cue && dlg && !/^[#@(]/.test(dlg)) pairs.push(`${cue}: ${dlg}`)
    }
  }
  // 고르게 솎기
  const out = []; let len = 0
  const step = Math.max(1, Math.floor(pairs.length / 120))
  for (let i = 0; i < pairs.length; i += step) { const p = pairs[i]; if (len + p.length > maxChars) break; out.push(p); len += p.length + 1 }
  return out.join('\n')
}

// 자막 → 텍스트 줄 (타임코드·번호 제거)
function subtitleSample(raw, maxChars = 3500, cap = 120) {
  let t = raw.replace(/\r/g, '')
  t = t.replace(/<SYNC[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ')
  const lines = t.split('\n').map(l => l.trim())
    .filter(l => l && !/^\d+$/.test(l) && !/-->/.test(l) && /[가-힣]/.test(l))
  const seen = new Set(); const uniq = []
  for (const l of lines) { if (!seen.has(l)) { seen.add(l); uniq.push(l) } }
  const step = Math.max(1, Math.floor(uniq.length / cap))
  const out = []; let len = 0
  for (let i = 0; i < uniq.length; i += step) { const l = uniq[i]; if (len + l.length > maxChars) break; out.push(l); len += l.length + 1 }
  return out.join('\n')
}

// 진단용 로컬 측정 (소스 품질·대사/지문 비율)
function quickMetrics(en) {
  const lines = en.replace(/\r/g, '').split('\n'); const nonEmpty = lines.filter(l => l.trim())
  const cues = lines.filter(l => /^@/.test(l)); const broken = cues.filter(l => /^@[^A-Z가-힣]/.test(l))
  const noise = nonEmpty.filter(l => /[\^~|\\]/.test(l) && !/[가-힣]{2,}|[A-Za-z]{4,}/.test(l))
  let dlg = 0, act = 0, aw = 0, after = false, saw = false
  for (const l of lines) { const t = l.trim()
    if (/^@/.test(t)) { after = true; saw = false; continue }
    if (/^#/.test(t)) { after = false; continue }
    if (t === '') { if (saw) after = false; continue }
    if (/^\(/.test(t)) continue
    if (after) { dlg++; saw = true } else { act++; aw += t.split(/\s+/).length } }
  return { scenes: lines.filter(l => /^#\s/.test(l)).length, cues: cues.length,
    brokenCueRatio: cues.length ? +(broken.length / cues.length).toFixed(2) : 0,
    noiseRatio: +(noise.length / (nonEmpty.length || 1)).toFixed(3),
    dialogueRatio: (dlg + act) ? +(dlg / (dlg + act)).toFixed(2) : 0, avgActionWords: act ? +(aw / act).toFixed(1) : 0 }
}

async function post(path, body) {
  const res = await fetch(`${SERVER}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json()
}

// 헬스
try { const h = await (await fetch(`${SERVER}/api/health`)).json(); if (!h.ok || !h.claude) { console.error('서버/Claude 준비 안 됨'); process.exit(1) } }
catch { console.error(`서버(${SERVER}) 연결 실패`); process.exit(1) }

const guidelines = (await post('/api/load-prompts', {})).translate || ''
const dialogueSample = buildDialogueSample(enText)
const subSample = subFile ? subtitleSample(readFileSync(join(dir, subFile), 'utf8')) : ''
console.log(`작품: ${work} · 자막: ${subFile || '없음'} · 대사샘플 ${dialogueSample.length}자 · 자막샘플 ${subSample.length}자`)

console.log('\n=== 인물 관계·말투 가이드 생성 중... ===')
const { register } = await post('/api/character-register', { dialogueSample, subtitleSample: subSample, model: MODEL })
console.log('\n' + (register || '(빈 가이드)') + '\n')

// === 작품 진단 → 처방 (번역 호출에 profile 주입) ===
const metrics = quickMetrics(enText)
const headSample = enText.replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(0, 40).join('\n').slice(0, 2000)
let profile = null
try {
  console.log('=== 작품 진단 중... ===')
  const dg = await post('/api/diagnose', { headSample, dialogueSample, subtitleSample: subSample, metrics, model: MODEL })
  profile = dg.profile
} catch (e) { console.warn('진단 실패(처방 없이 진행):', e.message) }
if (profile) {
  console.log(`[진단] 무게=${profile.weight} · 말투=${profile.register} · 자유도=${profile.latitude} · 플래그=[${(profile.flags || []).join(', ')}]`)
  if (profile.notes) console.log(`  특이: ${profile.notes}`)
  console.log(`  → 이 진단으로 처방(지침)이 번역에 주입됩니다.\n`)
} else { console.log('[진단] 프로파일 없음 — 표준 지침으로 진행\n') }

if (GUIDE_ONLY) { console.log('(--guide 모드 — 번역 안 함)'); process.exit(0) }
if (!WRITE) { console.log('(--write 없음 — 번역 안 함)'); process.exit(0) }

const RESUME = process.argv.includes('--resume')
const koPath = join(dir, trFile || fmtFile.replace('_formatted', '_translated'))
const scenes = splitScenes(enText)
// --resume: 기존 번역본에서 이미 한글인 씬은 재사용, 영어로 남은(실패) 씬만 재번역
let prevKo = null
if (RESUME && existsSync(koPath)) {
  const ks = splitScenes(readFileSync(koPath, 'utf8'))
  if (ks.length === scenes.length) prevKo = ks
  else console.log(`  (--resume 무시: 기존 ${ks.length}씬 ≠ 새 ${scenes.length}씬, 전체 재번역)`)
}
const reuseCount = prevKo ? prevKo.filter(s => /[가-힣]/.test(s)).length : 0
console.log(`=== 번역 시작: ${scenes.length}씬${RESUME && prevKo ? ` (재사용 ${reuseCount} · 재번역 ${scenes.length - reuseCount})` : ''} ===`)
const outScenes = []
let failed = 0
for (let i = 0; i < scenes.length; i++) {
  if (prevKo && /[가-힣]/.test(prevKo[i])) { outScenes.push(prevKo[i]); continue }   // 이미 한글 = 성공한 씬, 재사용
  const prevTail = i > 0 ? scenes[i - 1].split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
  let ok = false
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {   // 레이트리밋 등 일시 오류 재시도(백오프)
    try {
      const r = await post('/api/translate', {
        formattedText: scenes[i], characterMemo: register, guidelines, profile,
        sceneIndex: i, totalScenes: scenes.length, prevTail, model: MODEL,
      })
      outScenes.push((r.translated || '').trim()); ok = true
    } catch (e) {
      if (attempt === 2) { console.warn(`  씬 ${i} 실패(3회): ${e.message} — 원문 유지`); outScenes.push(scenes[i]); failed++ }
      else await new Promise(r => setTimeout(r, 5000 * (attempt + 1)))
    }
  }
  if ((i + 1) % 10 === 0 || i === scenes.length - 1) console.log(`  ${i + 1}/${scenes.length} (실패 ${failed})`)
}

const failRate = failed / scenes.length
if (failRate > 0.25) {
  console.error(`\n✗ 실패율 ${(failRate * 100).toFixed(0)}% (>25%) — 번역이 많이 깨져 덮어쓰기 중단. 기존 _translated 보존.`)
  writeFileSync(koPath.replace(/\.txt$/, '.retfailed.txt'), outScenes.join('\n\n') + '\n')
  console.error(`  부분 결과는 ${koPath.replace(/\.txt$/, '.retfailed.txt')} 에 저장(검토용). 서버 안정될 때 다시 실행하세요.`)
  process.exit(2)
}
if (existsSync(koPath) && !existsSync(koPath + '.retbak')) copyFileSync(koPath, koPath + '.retbak')
writeFileSync(koPath, outScenes.join('\n\n') + '\n')
console.log(`\n✓ ${koPath} (백업: .retbak · 실패 ${failed}/${scenes.length})`)
