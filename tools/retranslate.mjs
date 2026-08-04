// 청소된 _formatted.txt를 '가이드-온리' 새 흐름으로 재번역.
//   node tools/retranslate.mjs <작품폴더명> --guide       # 가이드만 생성·출력 (확인용)
//   node tools/retranslate.mjs <작품폴더명> --write        # 가이드 생성 후 전 씬 번역 → _translated.txt 덮어쓰기(.retbak)
// 서버(3001) 필요. 자막(KR srt/smi)이 있으면 말투·관계 가이드 근거로 씀. 번역엔 자막을 직접 안 넣음.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { reflowBody } from '../src/lib/format-rules.js'   // 끊긴 문장 합치기(변환과 동일)

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const MODEL = 'claude-opus-4-8'
const work = process.argv[2]
const GUIDE_ONLY = process.argv.includes('--guide')
const WRITE = process.argv.includes('--write')
const instrIdx = process.argv.indexOf('--instruction')
const INSTRUCTION = instrIdx >= 0 ? (process.argv[instrIdx + 1] || '') : ''   // 사용자 수정 지시 (읽다 발견한 오류 등)
const DIAGNOSE_ONLY = process.argv.includes('--diagnose-only')   // 진단만 하고 프로파일 저장 후 종료(게이트 1단계)
const pjIdx = process.argv.indexOf('--profile-json')
const PROFILE_JSON = pjIdx >= 0 ? (process.argv[pjIdx + 1] || '') : ''        // 진단 건너뛰고 이 프로파일로 번역(게이트 2단계)
const PROFILE_OUT = '/tmp/reproc_profile.json'
const srcIdx = process.argv.indexOf('--src')
const SRC = srcIdx >= 0 ? (process.argv[srcIdx + 1] || '') : ''               // formatted 소스 오버라이드(/tmp 재추출본). 있으면 content _formatted 안 읽음
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx >= 0 ? (process.argv[outIdx + 1] || '') : ''               // 출력 경로 오버라이드(/tmp). 있으면 content _translated 안 건드림(다운로드용)
if (!work) { console.error('사용: node tools/retranslate.mjs <작품폴더> --guide|--write'); process.exit(1) }

const dir = join(CONTENT, work)
const files = readdirSync(dir)
const fmtFile = files.find(f => /_formatted\.txt$/.test(f))
const trFile = files.find(f => /_translated\.txt$/.test(f))
const subFile = files.find(f => /KR\.(srt|smi)$/i.test(f)) || files.find(f => /\.(srt|smi)$/i.test(f) && /kr|ko|한/i.test(f)) || files.find(f => /\.(srt|smi)$/i.test(f))  // 마지막 fallback: 아무 자막이나(한글 없으면 subtitleSample이 비워 무시)
if (!fmtFile && !SRC) { console.error('_formatted.txt 없음'); process.exit(1) }
let enText = readFileSync(SRC || join(dir, fmtFile), 'utf8').replace(/\r/g, '')   // SRC(/tmp 재추출본) 우선, 없으면 content 읽기
enText = reflowBody(enText.split('\n')).join('\n')   // PDF 단 너비로 끊긴 문장 한 줄로 (번역 줄나눔 개선)

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
      const dlg = (lines[j] || '').trim().replace(/^-\s+/, '')   // 대사 마커('- ') 제거 — 샘플엔 순수 대사만
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

async function post(path, body, timeoutMs = 240000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)   // 서버가 응답 없이 멈춰도 무한 대기하지 않도록(과거: 씬 하나가 영원히 hang)
  try {
    const res = await fetch(`${SERVER}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
    if (!res.ok) throw new Error(`${path} ${res.status}`)
    return await res.json()
  } finally { clearTimeout(t) }
}

// 헬스
try { const h = await (await fetch(`${SERVER}/api/health`)).json(); if (!h.ok || !h.claude) { console.error('서버/Claude 준비 안 됨'); process.exit(1) } }
catch { console.error(`서버(${SERVER}) 연결 실패`); process.exit(1) }

let guidelines = (await post('/api/load-prompts', {})).translate || ''
if (INSTRUCTION) guidelines += `\n\n[사용자 수정 지시 — 최우선 반영]\n${INSTRUCTION}`
const dialogueSample = buildDialogueSample(enText)
const subSample = subFile ? subtitleSample(readFileSync(join(dir, subFile), 'utf8')) : ''
console.log(`작품: ${work} · 자막: ${subFile || '없음'} · 대사샘플 ${dialogueSample.length}자 · 자막샘플 ${subSample.length}자`)

// === 작품 진단(1회) → profile + 인물 말투 가이드(toneGuide). 처방은 번역 호출에 주입 ===
const metrics = quickMetrics(enText)
const headSample = enText.replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(0, 40).join('\n').slice(0, 2000)
let profile = null
if (PROFILE_JSON) {   // 게이트 2단계: 1단계에서 만든 프로파일 재사용 (진단 호출 생략)
  try { profile = JSON.parse(readFileSync(PROFILE_JSON, 'utf8')); console.log('[진단] 저장된 프로파일 재사용') } catch (e) { console.warn('프로파일 로드 실패:', e.message) }
} else {
  try {
    console.log('\n=== 작품 진단 중... ===')
    const dg = await post('/api/diagnose', { headSample, dialogueSample, subtitleSample: subSample, metrics, model: MODEL })
    profile = dg.profile
  } catch (e) { console.warn('진단 실패(처방 없이 진행):', e.message) }
}
const register = profile?.toneGuide || ''   // 말투 가이드 = 진단의 toneGuide (예전 character-register 통합)
if (profile) {
  console.log(`[진단] 무게=${profile.weight} · 자유도=${profile.latitude} · 플래그=[${(profile.flags || []).join(', ')}]`)
  if (profile.relations) console.log(`  관계: ${profile.relations}`)
  if (profile.notes) console.log(`  특이: ${profile.notes}`)
  console.log(`  말투가이드:\n${(register || '(없음)').split('\n').map(l => '    ' + l).join('\n')}`)
} else { console.log('[진단] 프로파일 없음 — 표준 지침으로 진행') }

// 게이트 1단계: 진단만 하고 프로파일 저장 + 씬 수 출력 후 종료 (서버가 받아 '번역 시작' 대기)
if (DIAGNOSE_ONLY) {
  try { writeFileSync(PROFILE_OUT, JSON.stringify(profile || {}, null, 0)) } catch {}
  console.log(`__SCENES__ ${splitScenes(enText).length}`)
  console.log('[진단 완료] 번역 대기')
  process.exit(0)
}

if (GUIDE_ONLY) { console.log('(--guide 모드 — 번역 안 함)'); process.exit(0) }
if (!WRITE) { console.log('(--write 없음 — 번역 안 함)'); process.exit(0) }

const RESUME = process.argv.includes('--resume')
const koPath = OUT || join(dir, trFile || fmtFile.replace('_formatted', '_translated'))   // OUT 있으면 /tmp(다운로드용), 없으면 content
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
if (!OUT && existsSync(koPath) && !existsSync(koPath + '.retbak')) copyFileSync(koPath, koPath + '.retbak')   // content 모드일 때만 원본 백업 (OUT=/tmp면 백업 불필요)
// 현재까지 번역분 + 나머지 영문으로 전체 구조 유지해 저장 (끊겨도 안 날아감 / --resume으로 이어감)
const checkpoint = (out) => { try { writeFileSync(koPath, [...out, ...scenes.slice(out.length)].join('\n\n') + '\n') } catch {} }
const outScenes = []
let failed = 0
for (let i = 0; i < scenes.length; i++) {
  if (prevKo && /[가-힣]/.test(prevKo[i])) { outScenes.push(prevKo[i]); continue }   // 이미 한글 = 성공한 씬, 재사용
  const prevTail = i > 0 ? scenes[i - 1].split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
  // 씬 길이에 비례한 타임아웃: 정상 씬(수천자)은 기존과 비슷하게, 헤딩 없이 통째로 묶인
  // 초대형 씬(예: EEAAO 멀티버스 몽타주 4만자)은 응답이 오래 걸려도 일찍 abort돼 계속 실패하던 문제 방지.
  const sceneTimeout = Math.min(600000, 90000 + scenes[i].length * 15)
  let ok = false
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {   // 레이트리밋 등 일시 오류 재시도(백오프)
    try {
      const r = await post('/api/translate', {
        formattedText: scenes[i], characterMemo: register, guidelines, profile,
        sceneIndex: i, totalScenes: scenes.length, prevTail, model: MODEL,
      }, sceneTimeout)
      outScenes.push((r.translated || '').trim()); ok = true
    } catch (e) {
      if (attempt === 2) { console.warn(`  씬 ${i} 실패(3회): ${e.message} — 원문 유지`); outScenes.push(scenes[i]); failed++ }
      else await new Promise(r => setTimeout(r, 5000 * (attempt + 1)))
    }
  }
  if ((i + 1) % 20 === 0) checkpoint(outScenes)   // 20씬마다 중간 저장
  if ((i + 1) % 10 === 0 || i === scenes.length - 1) console.log(`  ${i + 1}/${scenes.length} (실패 ${failed})`)
}
writeFileSync(koPath, outScenes.join('\n\n') + '\n')   // 최종 저장
console.log(`\n✓ ${koPath} (백업: .retbak · 실패 ${failed}/${scenes.length})`)
