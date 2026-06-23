import { createServer } from 'http'
import { spawn, execSync } from 'child_process'
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ruleFormat } from './src/lib/format-rules.js'
import { alignSmi } from './src/lib/smi.js'
import { splitGluedAction } from './src/lib/lint.js'
import {
  estTokens, cleanOutput, looksLikeRefusal, buildDialogueSample, buildSubtitleSample, buildBatches, splitByHeading,
} from './src/lib/pipeline.js'

const PORT = 3001
const PROMPTS_PATH = `${process.cwd()}/prompts.json`
const PROFILES_PATH = `${process.cwd()}/profiles.json`

// 진단(profile) → 처방 조립. profiles.json의 조각을 골라 번역 지침에 덧붙일 한 덩어리로.
function loadProfiles() { try { return JSON.parse(readFileSync(PROFILES_PATH, 'utf8')) } catch { return {} } }
function assembleProfilePrescription(profile) {
  if (!profile) return ''
  const P = loadProfiles()
  const parts = []
  if (profile.latitude && P.latitude?.[profile.latitude]) parts.push(`- ${P.latitude[profile.latitude]}`)
  if (profile.register && P.register?.[profile.register]) parts.push(`- ${P.register[profile.register]}`)
  for (const f of (profile.flags || [])) if (P.flags?.[f]) parts.push(`- ${P.flags[f]}`)
  if (!parts.length) return ''
  return `\n\n[이 작품 진단에 따른 처방 — 위 지침보다 이 작품 성격에 맞춰 우선 적용]\n${parts.join('\n')}`
}
// 진단용 로컬 측정 (소스 품질·대사/지문 비율)
function quickMetrics(en) {
  const lines = (en || '').replace(/\r/g, '').split('\n'); const nonEmpty = lines.filter(l => l.trim())
  const cues = lines.filter(l => /^@/.test(l)); const broken = cues.filter(l => /^@[^A-Z가-힣]/.test(l))
  const noise = nonEmpty.filter(l => /[\^~|\\]/.test(l) && !/[가-힣]{2,}|[A-Za-z]{4,}/.test(l))
  let dlg = 0, act = 0, aw = 0, after = false, saw = false
  for (const l of lines) {
    const t = l.trim()
    if (/^@/.test(t)) { after = true; saw = false; continue }
    if (/^#/.test(t)) { after = false; continue }
    if (t === '') { if (saw) after = false; continue }
    if (/^\(/.test(t)) continue
    if (after) { dlg++; saw = true } else { act++; aw += t.split(/\s+/).length }
  }
  return { scenes: lines.filter(l => /^#\s/.test(l)).length, cues: cues.length,
    brokenCueRatio: cues.length ? +(broken.length / cues.length).toFixed(2) : 0,
    noiseRatio: +(noise.length / (nonEmpty.length || 1)).toFixed(3),
    dialogueRatio: (dlg + act) ? +(dlg / (dlg + act)).toFixed(2) : 0, avgActionWords: act ? +(aw / act).toFixed(1) : 0 }
}

// 지침을 repo 파일에 저장/로드 (동료가 클론하면 그대로 공유)
function handleLoadPrompts() {
  try { return JSON.parse(readFileSync(PROMPTS_PATH, 'utf8')) } catch { return {} }
}
function handleSavePrompts(body) {
  const cur = handleLoadPrompts()
  const next = { ...cur }
  if (body.format != null) next.format = body.format
  if (body.translate != null) next.translate = body.translate
  writeFileSync(PROMPTS_PATH, JSON.stringify(next, null, 2))
  return { ok: true }
}

// 영화별 인물 글로서리(메모)도 repo 파일에 — 같은 작품 다시 변환/동료 공유 시 재사용
const GLOSS_PATH = `${process.cwd()}/glossaries.json`
function handleLoadGlossary() {
  try { return JSON.parse(readFileSync(GLOSS_PATH, 'utf8')) } catch { return {} }
}
function handleSaveGlossary(body) {
  const cur = handleLoadGlossary()
  if (body.title) cur[body.title] = body.memo || ''
  writeFileSync(GLOSS_PATH, JSON.stringify(cur, null, 2))
  return { ok: true }
}

// 처리 진단 로그 누적 (어떻게 읽고 처리했는지 → 오류 추적·학습용)
const LOG_PATH = `${process.cwd()}/process-log.jsonl`
function handleLog(body) {
  try { appendFileSync(LOG_PATH, JSON.stringify(body) + '\n') } catch {}
  return { ok: true }
}

// 스캔 PDF OCR 폴백 — pdftoppm(이미지 변환) + tesseract(문자 인식). 둘 다 로컬, 토큰 0.
// 클라이언트가 텍스트 레이어 0인 PDF를 base64로 보내면 페이지별로 OCR해서 텍스트 반환.
let OCR_TOOLS = null   // null=미확인, true/false=확인됨
function ocrToolsReady() {
  if (OCR_TOOLS !== null) return OCR_TOOLS
  OCR_TOOLS = ['pdftoppm', 'tesseract'].every(bin => {
    try { execSync(`${bin} --version`, { stdio: 'ignore' }); return true } catch { return false }
  })
  return OCR_TOOLS
}
function runOcrPage(buf) {
  // leptonica가 파일 경로 열기에 버그가 있어 stdin으로 전달 (`cat png | tesseract - stdout`)
  return new Promise((resolve, reject) => {
    const t = spawn('tesseract', ['-', 'stdout', '-l', 'eng'])
    let out = ''
    t.stdout.on('data', d => out += d)
    t.on('error', reject)
    t.on('close', () => resolve(out))
    t.stdin.on('error', () => {})
    t.stdin.write(buf); t.stdin.end()
  })
}
async function handleOcr(data, onProgress) {
  const { pdfBase64 } = data
  if (!pdfBase64) throw new Error('pdfBase64 required')
  if (!ocrToolsReady()) {
    const e = new Error('OCR 도구(pdftoppm·tesseract)가 설치돼 있지 않아요. `brew install poppler tesseract`')
    e.code = 'OCR_TOOLS_MISSING'; throw e
  }
  const dir = mkdtempSync(join(tmpdir(), 'srocr-'))
  try {
    const pdfPath = join(dir, 'in.pdf')
    writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'))
    // 1) 페이지 → PNG (200dpi: 스캔 각본엔 충분, 속도↑)
    await new Promise((resolve, reject) => {
      const p = spawn('pdftoppm', ['-r', '200', '-png', pdfPath, join(dir, 'pg')])
      let err = ''
      p.stderr.on('data', d => err += d)
      p.on('error', reject)
      p.on('close', c => c === 0 ? resolve() : reject(new Error('pdftoppm 실패: ' + err.slice(0, 200))))
    })
    // 2) PNG별 OCR (순차)
    const pngs = readdirSync(dir).filter(f => f.endsWith('.png')).sort()
    const out = []
    for (let i = 0; i < pngs.length; i++) {
      out.push(await runOcrPage(readFileSync(join(dir, pngs[i]))))
      onProgress?.(i + 1, pngs.length)
    }
    return { text: out.join('\n'), pages: pngs.length }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// claude 바이너리 경로 탐색
function findClaude() {
  // 1. PATH에 있으면 바로 사용
  try { execSync('claude --version', { stdio: 'ignore' }); return 'claude' } catch {}

  // 2. Claude Code 앱 설치 경로에서 최신 버전 탐색
  const appDir = `${process.env.HOME}/Library/Application Support/Claude/claude-code`
  try {
    const versions = readdirSync(appDir).sort().reverse()
    for (const v of versions) {
      const bin = `${appDir}/${v}/claude.app/Contents/MacOS/claude`
      try { execSync(`"${bin}" --version`, { stdio: 'ignore' }); return bin } catch {}
    }
  } catch {}

  return null  // 못 찾으면 부팅은 죽이지 않고, 번역 시점에 친화적 안내
}

const CLAUDE_BIN = findClaude()
if (!CLAUDE_BIN) console.error('⚠ Claude Code CLI를 찾을 수 없습니다 — 설치 후 로그인하세요. (화면에서도 안내됩니다)')

function modelAlias(m) {
  if (!m) return null
  const s = String(m).toLowerCase()
  if (s.includes('opus')) return 'opus'
  if (s.includes('sonnet')) return 'sonnet'
  if (s.includes('haiku')) return 'haiku'
  return null
}

// 널 바이트·제어문자 제거 — spawn args에 널이 있으면 즉시 throw됨(잘못 디코딩된 자막 등 방어)
const sanitize = s => (s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

// 일시적(재시도 가치 있는) 오류 — API 연결 실패·소켓·타임아웃 등
const isTransient = m => /unable to connect|connection ?refused|failedtoopensocket|econnrefused|econnreset|etimedout|socket|timeout|network|temporarily|overloaded|503|529/i.test(m || '')

// 살아있는 claude 자식 추적 → 서버 종료 시 함께 정리 (좀비 누적·소켓 고갈 방지)
const liveProcs = new Set()
function killChildren() { for (const p of liveProcs) { try { p.kill('SIGKILL') } catch {} } liveProcs.clear() }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killChildren(); process.exit(0) })
process.on('exit', killChildren)

function spawnClaude(systemPrompt, userPrompt, model) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_BIN) { const e = new Error('Claude Code가 설치되어 있지 않아요'); e.code = 'CLAUDE_NOT_FOUND'; reject(e); return }
    // 토큰 절감: Claude Code 기본 시스템 프롬프트(~12k) + 툴 정의(~11k)를 통째로 제거.
    const args = [
      '-p',
      '--system-prompt', systemPrompt,
      '--disallowedTools', 'Bash Read Edit Write Glob Grep Task WebFetch WebSearch NotebookEdit TodoWrite',
      '--strict-mcp-config',
      '--setting-sources', '',
    ]
    const alias = modelAlias(model)
    if (alias) args.push('--model', alias)
    const proc = spawn(CLAUDE_BIN, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    liveProcs.add(proc)

    let out = '', err = ''
    proc.stdout.on('data', d => out += d)
    proc.stderr.on('data', d => err += d)
    proc.on('error', e => { liveProcs.delete(proc); reject(new Error(e.message)) })
    proc.on('close', code => {
      liveProcs.delete(proc)
      if (code !== 0) {
        const combined = (err + ' ' + out).toLowerCase()
        if (/rate limit|usage limit|too many|quota/.test(combined)) {
          const e = new Error('RATE_LIMIT'); e.code = 'RATE_LIMIT'; reject(e); return
        }
        // 로그인/인증 문제 — 안내가 필요한 별도 분류
        if (/not logged in|please run.*login|run .?claude.? to log|log ?in to claude|authentication|unauthorized|invalid api key|no credentials|missing.*api key|claude login|로그인/i.test(combined)) {
          const e = new Error('Claude 로그인이 필요해요'); e.code = 'AUTH'; reject(e); return
        }
        // 진짜 원인을 표면화: API 에러 메시지 우선(stderr 경고보다)
        const apiErr = out.match(/API Error:[^\n]*/i)?.[0] || err.match(/API Error:[^\n]*/i)?.[0]
        reject(new Error(apiErr || err.trim() || out.trim() || `exit code ${code}`))
      } else resolve(out.trim())
    })
    proc.stdin.write(userPrompt)
    proc.stdin.end()
  })
}

// 일시적 연결 오류는 백오프 재시도 (동시 작업이 많을 때 소켓 거부 등). 한도·영구오류는 즉시 throw.
async function runClaude(systemPrompt, userPrompt, model) {
  systemPrompt = sanitize(systemPrompt)
  userPrompt = sanitize(userPrompt)
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await spawnClaude(systemPrompt, userPrompt, model) }
    catch (e) {
      if (e.code === 'RATE_LIMIT') throw e
      lastErr = e
      if (!isTransient(e.message)) { console.error('claude 오류(비일시적):', e.message); throw e }
      console.error(`claude 일시적 오류 재시도(${attempt + 1}/4):`, e.message.slice(0, 80))
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 500))
    }
  }
  throw lastErr
}

async function handleFormat(body) {
  const { sceneText, guidelines, sceneIndex, totalScenes, model } = body
  if (!sceneText) throw new Error('sceneText required')

  const systemPrompt = `당신은 영화 각본 포매터입니다. 원본 각본 텍스트를 받아 지정된 형식으로 변환하세요.

지침:
${guidelines}

중요: JSON이 아닌 순수 텍스트로만 응답하세요. 설명이나 주석 없이 변환된 각본 텍스트만 출력하세요.
포맷할 실제 각본 내용이 없으면(타이틀·표지·빈 페이지 등) 입력을 그대로 출력하세요. 절대 질문하거나 설명·요청·예시를 덧붙이지 마세요.`

  const userPrompt = `다음 각본 텍스트를 포맷하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${sceneText}`

  let formatted = await runClaude(systemPrompt, userPrompt, model)
  // 빈 씬에서 LLM이 대화체로 답하면 → 저장하지 말고 원문 유지
  if (looksLikeRefusal(formatted)) formatted = sceneText
  return { formatted, tokens: null }
}

async function handleTranslate(body) {
  const { formattedText, characterMemo, guidelines, profile, sceneIndex, totalScenes, targetLang, prevTail, model } = body
  if (!formattedText) throw new Error('formattedText required')

  // 자막은 번역에 안 들어감 — 작품당 1회 만든 '말투 글로서리'(characterMemo)로만 자막 지식이 반영됨.
  const memoSection = characterMemo ? `\n\n[인물 말투·관계 가이드 — 씬이 갈려도 각 인물의 말투(반말/존댓말)·호칭을 이 가이드대로 일관되게]\n${characterMemo}` : ''
  const rxSection = assembleProfilePrescription(profile)   // 진단 처방 (있으면 작품 성격별 지침 주입)
  const prevSection = prevTail ? `\n\n[직전 장면 끝부분 — 대명사·상황 맥락 참고용. 번역하지 말 것]\n${prevTail}` : ''
  const lang = targetLang || '한국어'

  const systemPrompt = `당신은 영화 각본 번역가입니다. 포맷된 각본 텍스트를 ${lang}로 번역하세요.

규칙(엄수):
- 주어진 [번역할 원문]에 있는 내용만 번역. 없는 대사·지문·장면·헤딩 만들지 말 것(유명작이어도 기억으로 다시 쓰지 말 것). 이어쓰기·각색·확장 금지.
- 입력 줄을 1:1로 번역 — 줄 수·순서·빈 줄 위치를 원문과 똑같이. 줄 합치기·나누기·추가 금지(영문 포맷과 줄 단위로 정렬돼야 함).
- @인물명·전환지시어 형태 유지. 짧고 거칠어도 각색 말고 그대로.

지침:
${guidelines}${rxSection}${memoSection}${prevSection}

순수 텍스트만 출력(JSON·설명·예시 금지). 번역할 내용이 없으면(타이틀·표지·빈 페이지) 입력 그대로.`

  const userPrompt = `다음 [번역할 원문]만 번역하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}. 여기 있는 줄만 옮기고, 없는 내용은 만들지 마세요.

[번역할 원문]
${formattedText}`

  let translated = await runClaude(systemPrompt, userPrompt, model)
  // 빈 씬에서 LLM이 번역 대신 "각본을 붙여넣어 주세요" 류 대화체로 답하면 → 저장하지 말고 원문 유지
  if (looksLikeRefusal(translated)) translated = formattedText
  return { translated, tokens: null }
}

// 인물 말투 사전 — 작품당 1회. 씬마다 따로 번역해도 말투가 일관되게 유지되도록 가이드 생성.
// 공식 한국어 자막(subtitleSample)이 있으면 그 경어/호칭/의역을 '근거'로 더 정확한 가이드를 만든다.
async function handleCharacterRegister(body) {
  const { dialogueSample, subtitleSample, model } = body
  if (!dialogueSample) return { register: '' }
  const hasSub = !!(subtitleSample && subtitleSample.trim())
  const systemPrompt = `당신은 영화 각본 번역 디렉터입니다. 한국어 번역에 쓸 '인물 관계·말투 가이드'를 만드세요.

목적: 각본을 씬 단위로 따로 번역해도, 인물들의 관계·거리감·말투(반말/존댓말)·호칭이 작품 전체에서 일관되게 유지되도록. 번역자는 이 가이드만 보고 각 대사의 톤을 정합니다.
${hasSub ? `
중요(근거 우선): 아래에 이 작품의 **공식 한국어 자막** 샘플이 함께 주어집니다. 공식 자막이 인물들의 말을 어떻게 옮겼는지(반말/존댓말, 호칭, 관계의 거리감)를 **가장 신뢰할 근거**로 삼으세요. 단, 자막의 '특정 문장'을 베끼라는 게 아니라, 자막에서 드러나는 **관계와 말투의 패턴**을 읽어 가이드로 추상화하는 것입니다.` : ''}
다음 두 부분으로 작성:

[관계] — 2~4줄. 핵심 인물 간 관계와 거리감, 권력/친밀도 구도, 이야기상 톤(예: "X와 Y는 연인이나 늘 긴장 관계", "Z는 X의 상사로 시종 거리를 둠"). 말투가 어디서 바뀌는지(친해짐/틀어짐)도 있으면 한 줄.

[인물] — 1줄=1인물. 핵심 인물 12명 이내:
- 기본 말투(반말/존댓말). 상대에 따라 다르면 상대별로 명시 (예: A에게 존댓말, 동료에게 반말)
- 특징적 호칭/말버릇 있으면 짧게
${hasSub ? '\n그리고 마지막에 "[톤]" 한 줄로, 공식 자막이 보이는 특징적 의역/말버릇 톤(욕설 순화 정도, 호칭 습관 등)을 적으세요.\n' : ''}
예)
[관계]
코브는 팀의 리더로 의뢰인 사이토에게 거리를 두는 프로. 아리아드네는 신참이라 코브에게 배우는 입장.
[인물]
코브: 사이토·의뢰인에게 존댓말(프로페셔널), 팀원에겐 편한 반말
아리아드네: 코브에게 존댓말, 또래 팀원에겐 반말

중요: 설명·머리말·번호 없이 위 형식 그대로. 추측이면 자연스러운 기본값으로.`
  const userPrompt = hasSub
    ? `[영어 각본 대사 샘플]\n${dialogueSample}\n\n[공식 한국어 자막 샘플 — 말투 근거]\n${subtitleSample}`
    : `대사 샘플:\n${dialogueSample}`
  const register = await runClaude(systemPrompt, userPrompt, model)
  return { register: (register || '').trim() }
}

// 작품 프로파일러(진단) — 작품당 1회. 로컬 측정(metrics)으로 소스 품질·무게중심을 객관 수치로 주고,
// 모델은 내용·말투·관계·스타일을 진단해 프로파일 JSON으로 반환. (처방=지침 조립은 별도 단계)
async function handleDiagnose(body) {
  const { headSample, dialogueSample, subtitleSample, metrics, model } = body
  const hasSub = !!(subtitleSample && subtitleSample.trim())
  const systemPrompt = `당신은 영화 각본 번역 디렉터입니다. 주어진 각본을 "진단"해서 어떤 번역 전략이 맞는지 판단합니다.
아래 로컬 측정치(소스 품질·대사/지문 비율 등)와 본문·자막 샘플을 보고, 이 작품의 성격을 진단하세요.

반드시 **JSON만** 출력 (설명·코드펜스 금지). 형식:
{
  "weight": "dialogue" | "description" | "mixed",          // 글의 무게중심: 대사형/지문형/혼합
  "register": "casual" | "formal" | "stylized" | "family", // 말투: 현대일상/격식시대/강한문체(누아르·욕설·랩식)/아동가족
  "flags": [],   // 해당되는 것만: "songs"(노래·뮤지컬) "narration"(내레이션多) "heavy_credits" "famous"(유명작)
  "latitude": "loose" | "balanced" | "tight",  // 번역 자유도. 대사형·일상=loose / 지문형·정밀=tight / 섞이면 balanced
  "synopsis": "한 문단 줄거리(아는 작품이면 일반지식 OK, 모르면 샘플 기반 추정)",
  "relations": "핵심 인물 관계·거리감 1~3줄 (자막 있으면 그 말투 근거로)",
  "notes": "위 축에 안 잡히는 번역상 특이사항을 자유롭게 (없으면 빈 문자열)"
}
판단은 너의 몫이다. 정형 값에 억지로 끼우지 말고, 애매하면 notes에 적어라.`
  const userPrompt = `[로컬 측정치]\n${JSON.stringify(metrics || {}, null, 0)}\n\n[본문 앞부분 샘플]\n${headSample || ''}\n\n[대사 샘플]\n${dialogueSample || ''}${hasSub ? `\n\n[공식 한국어 자막 샘플]\n${subtitleSample}` : ''}`
  const raw = await runClaude(systemPrompt, userPrompt, model)
  let profile = null
  try { profile = JSON.parse((raw || '').replace(/^```(json)?/i, '').replace(/```$/, '').trim()) } catch {}
  return { profile, raw: profile ? undefined : (raw || '').slice(0, 500) }   // 파싱 실패 시 원문 일부로 디버그
}

// 문제 구간만 받아서 수정 (surgical patch)
async function handlePatch(body) {
  const { chunk, instruction, fileType } = body
  if (!chunk) throw new Error('chunk required')

  const typeLabel = fileType === 'translated' ? '번역된 각본' : '포맷된 각본'
  const systemPrompt = `당신은 각본 교정 전문가입니다. ${typeLabel}의 특정 구간을 받아 지정된 사항만 수정합니다.

수정 지시:
${instruction}

중요:
- 지시된 사항만 수정하고 나머지는 절대 변경하지 마세요
- 번역 내용, 대사 내용은 건드리지 마세요
- 순수 텍스트로만 응답하세요. 같은 줄 수를 유지하려고 노력하세요.`

  const userPrompt = `다음 구간을 수정하세요:\n\n${chunk}`
  const patched = await runClaude(systemPrompt, userPrompt)
  return { patched }
}

// 검수 피드백(해석필요) — 지적에 맞게 번역 '내용'을 고침
async function handleFixFeedback(body) {
  const { ko, en, note, guidelines, model } = body
  if (!ko) throw new Error('ko required')
  const systemPrompt = `당신은 영화 각본 번역 교정가입니다. 검수자의 지적에 따라 한국어 번역을 자연스럽게 고칩니다.
${guidelines ? `\n번역 지침:\n${guidelines}\n` : ''}
검수자 지적:
${note}
${en ? `\n원문(영어): ${en}` : ''}

중요:
- 지적에 맞게 번역 '내용'을 고치세요 (반말/존댓말, 오역, 어색함 등 포함)
- 고친 한국어 텍스트만 출력 (설명·따옴표 없이)
- @·#·괄호 등 마커와 구조는 유지`
  const userPrompt = `현재 번역:\n${ko}\n\n위를 지적에 맞게 고친 번역만 출력하세요.`
  const fixed = await runClaude(systemPrompt, userPrompt, model)
  return { fixed: (fixed || '').trim() }
}

async function handleDetectHeadings(body) {
  const { candidates } = body
  if (!candidates || candidates.length === 0) return { indices: [] }

  // 너무 많으면 앞 500개만 (약 5~8k 토큰)
  const limited = candidates.slice(0, 500)
  const list = limited.map(c => `[${c.idx}] ${c.text}`).join('\n')

  const systemPrompt = `각본 텍스트에서 추출한 후보 줄 목록이야.
각 줄의 인덱스와 텍스트가 나열되어 있어.
이 중에서 씬 헤딩(장면 구분선)에 해당하는 줄의 인덱스만 JSON 배열로 반환해.

씬 헤딩 기준:
- INT. / EXT. 로 시작하는 표준 형식
- LOCKER ROOM - DAY, STADIUM - NIGHT 같이 장소명으로 시작하는 비표준 형식
- INSERT, INTERCUT WITH, MONTAGE, SERIES OF SHOTS 등

씬 헤딩이 아닌 것:
- 인물 이름 (BILLY, CASEY, PETER 등 대사 큐)
- 전환 지시어 (CUT TO, FADE IN 등)
- OMITTED, GRAPHICS, A GRAPHIC, IN BLACK, LEGEND, TITLE 등
- 단독 장면 설명 (A DIFFERENT TWIN, THE NEXT MORNING 등)

반드시 JSON 배열 형식만 반환. 예: [5, 23, 47, 112]
설명 없이 배열만.`

  const userPrompt = `후보 줄:\n${list}`

  const result = await runClaude(systemPrompt, userPrompt)
  const match = result.match(/\[\s*[\d,\s]*\]/)
  let indices = []
  if (match) {
    try { indices = JSON.parse(match[0]) } catch {}
  }
  return { indices }
}

async function handleRevise(body) {
  const { sceneText, guidelines, mode, sceneIndex, totalScenes, model } = body
  if (!sceneText) throw new Error('sceneText required')

  const modeLabel = mode === 'translated' ? '번역된 각본' : '포맷된 각본'
  const systemPrompt = `당신은 영화 각본 교정 전문가입니다. 이미 처리된 ${modeLabel} 텍스트를 받아 아래 지침에 맞게 수정하세요.

지침:
${guidelines}

중요: 수정된 텍스트만 출력하세요. 설명이나 주석 없이 순수 텍스트로만 응답하세요.`

  const userPrompt = `다음 ${modeLabel}을 지침에 맞게 수정하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${sceneText}`

  const revised = await runClaude(systemPrompt, userPrompt, model)
  return { revised, tokens: null }
}

// ============================================================================
// 잡 러너 — 작업 루프를 서버 프로세스가 소유. 디스크 영속 → 탭 닫기/sleep/재시작에도 이어서.
// ============================================================================
const JOBS_DIR = `${process.cwd()}/jobs`
mkdirSync(JOBS_DIR, { recursive: true })
const jobs = new Map() // id -> job

// 전역 동시성: 여러 잡이 동시에 돌아도 claude 프로세스 총량을 한 상한으로 묶음
let GLOBAL_CAP = 3
let activeSlots = 0
const slotWaiters = []
function acquireSlot() {
  return new Promise(res => {
    if (activeSlots < GLOBAL_CAP) { activeSlots++; res() }
    else slotWaiters.push(res)
  })
}
function releaseSlot() {
  activeSlots = Math.max(0, activeSlots - 1)
  if (slotWaiters.length && activeSlots < GLOBAL_CAP) { activeSlots++; slotWaiters.shift()() }
}
async function withSlot(fn) { await acquireSlot(); try { return await fn() } finally { releaseSlot() } }

// 디스크 영속 (잡당 throttle: 1초당 1회)
const saveTimers = new Map()
function persistJob(job) {
  try { writeFileSync(`${JOBS_DIR}/${job.id}.json`, JSON.stringify(job)) } catch (e) { console.error('persistJob', e.message) }
}
function saveJob(job, immediate = false) {
  if (immediate) {
    if (saveTimers.has(job.id)) { clearTimeout(saveTimers.get(job.id)); saveTimers.delete(job.id) }
    persistJob(job); return
  }
  if (saveTimers.has(job.id)) return
  saveTimers.set(job.id, setTimeout(() => { saveTimers.delete(job.id); persistJob(job) }, 1000))
}
function deleteJobFile(id) { try { unlinkSync(`${JOBS_DIR}/${id}.json`) } catch {} }

function doneCount(job) { return job.scenes.filter(s => s.status === 'done').length }
function jobMeta(job) {
  return {
    id: job.id, title: job.title, phase: job.phase, status: job.status,
    startTime: job.startTime, duration: job.duration || null,
    activeMs: job.activeMs || 0, runningSince: job._runStart || null,  // 실제 처리 시간(방치 제외)
    total: job.scenes.length, done: doneCount(job),
    errors: job.scenes.filter(s => s.status?.startsWith('error')).length,
    profile: job.profile || null,   // 작품 진단 결과 (UI 프로파일 카드용)
  }
}

// 실제 처리 시간(activeMs) 누적 — 일시정지·방치 시간 제외. 상태가 running↔아님 바뀔 때 호출.
function setRunning(job, on) {
  if (on) { if (!job._runStart) job._runStart = Date.now() }
  else if (job._runStart) { job.activeMs = (job.activeMs || 0) + (Date.now() - job._runStart); job._runStart = null }
}
function rateLimitJob(job) { setRunning(job, false); job.status = 'rate_limited'; job.paused = true; saveJob(job, true) }
// 로그인/미설치 등 사람이 고쳐야 하는 문제 → 전 씬 헛돌지 않게 잡 일시정지
function haltJob(job) { setRunning(job, false); job.paused = true; if (job.status === 'running') job.status = 'paused'; saveJob(job, true) }

// 일시정지 대기 (잡 단위). stop이면 즉시 빠져나감.
function waitWhilePaused(job) {
  return new Promise(resolve => {
    const check = () => (job.paused && !job.stopped) ? setTimeout(check, 300) : resolve()
    check()
  })
}

async function formatScene(job, scene) {
  scene.status = 'formatting'
  // 규칙 우선 — 깔끔한 씬은 LLM 없이(0토큰). 확신 낮으면 LLM 폴백.
  const rf = ruleFormat(scene.raw)
  if (rf.confidence >= 0.7) {
    // ★ 영어 포맷본에 대사↔지문 빈 줄 분리를 적용 — 번역이 이걸 1:1로 따라오게 (구분+정렬 동시 충족)
    const ruleFmt = splitGluedAction(rf.formatted)
    const heading = ruleFmt.split('\n')[0].trim()
    scene.formatted = ruleFmt
    scene.formatMethod = 'rule'
    scene.heading = heading.startsWith('#') ? heading : null
    scene.tokens = { ...scene.tokens, format_in: 0, format_out: 0 }
    scene.status = 'formatted'
    return
  }
  try {
    const res = await withSlot(() => handleFormat({
      sceneText: scene.raw, guidelines: job.guidelines.format,
      sceneIndex: scene.id, totalScenes: job.scenes.length,
      model: job.settings.formatModel || job.settings.model,
    }))
    const formatted = splitGluedAction(cleanOutput(res.formatted))  // ★ 대사↔지문 분리 (영어=기준)
    const heading = formatted.split('\n')[0].trim()
    scene.formatted = formatted
    scene.formatMethod = 'llm'
    scene.heading = heading.startsWith('#') ? heading : null
    scene.tokens = { ...scene.tokens, format_in: estTokens(scene.raw), format_out: estTokens(formatted) }
    scene.status = 'formatted'
  } catch (e) {
    if (e.code === 'RATE_LIMIT') rateLimitJob(job)
    if (e.code === 'AUTH' || e.code === 'CLAUDE_NOT_FOUND') haltJob(job)
    scene.status = 'error_format'; scene.error = e.message
  }
}

// 정렬 메타만 계산 (텍스트 교체 안 함). 한국어 자막일 때만 의미 있음.
function alignMeta(job, text) {
  return job.smi?.entries ? alignSmi(text, job.smi.entries).matches : []
}

// 번역 구조 검증 — 영문 포맷본과 마커·줄 수가 맞는지. 누락·창작·거부·환각을 한 번에 걸러냄.
// #(헤딩)·@(인물 큐) 줄 수는 지침상 1:1 보존돼야 하고, 비어있지 않은 줄 수도 비슷해야 함.
function translationStructureOk(formatted, translated) {
  if (!translated || !translated.trim()) return false
  const heads = (t) => (t.match(/^#/gm) || []).length
  const cues = (t) => (t.match(/^@/gm) || []).length
  const body = (t) => t.split('\n').filter(l => l.trim()).length
  if (heads(formatted) !== heads(translated)) return false   // 헤딩 수 불일치 = 씬 누락/창작
  if (cues(formatted) !== cues(translated)) return false      // 인물 큐 수 불일치 = 대사 누락/창작
  const bf = body(formatted), bt = body(translated)
  if (bf > 0 && (bt < bf * 0.6 || bt > bf * 1.6)) return false // 줄 수가 크게 벗어남
  return true
}

async function translateOne(job, scene) {
  scene.status = 'translating'
  try {
    const idx = job.scenes.findIndex(s => s.id === scene.id)
    const prev = idx > 0 ? job.scenes[idx - 1] : null
    const prevTail = prev ? prev.raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
    // ★ 구조 가드: 안 맞으면 에러 표시만 (자동 재번역 안 함 — 토큰 절약. 재처리는 사용자가 ↻/버튼으로)
    const res = await withSlot(() => handleTranslate({
      formattedText: scene.formatted, prevTail,
      characterMemo: job.characterMemo || null, guidelines: job.guidelines.translate, profile: job.profile || null,
      sceneIndex: scene.id, totalScenes: job.scenes.length,
      model: job.settings.translateModel || job.settings.model,
    }))
    const translated = cleanOutput(res.translated)  // 줄 1:1 유지 — splitGluedAction 미적용
    scene.translated = translated
    scene.smiMatches = alignMeta(job, translated)  // 정렬은 메타만 (교체 없음)
    scene.tokens = { ...scene.tokens, translate_in: estTokens(scene.formatted), translate_out: estTokens(translated) }
    if (!translationStructureOk(scene.formatted, translated)) {
      scene.status = 'error_translate'; scene.error = '구조 불일치: 영문 포맷과 줄·마커 수가 안 맞음 (누락/창작/거부 의심) — 재처리 필요'; return
    }
    scene.status = 'done'
  } catch (e) {
    if (e.code === 'RATE_LIMIT') rateLimitJob(job)
    if (e.code === 'AUTH' || e.code === 'CLAUDE_NOT_FOUND') haltJob(job)
    scene.status = 'error_translate'; scene.error = e.message
  }
}

async function translateBatch(job, batch) {
  batch.forEach(s => { s.status = 'translating' })
  const fallback = async () => { for (const s of batch) await translateOne(job, s) }
  try {
    const combined = batch.map(s => s.formatted).join('\n\n')
    const firstId = batch[0].id
    const idx = job.scenes.findIndex(s => s.id === firstId)
    const prev = idx > 0 ? job.scenes[idx - 1] : null
    const prevTail = prev ? prev.raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 220) : null
    const res = await withSlot(() => handleTranslate({
      formattedText: combined, prevTail,
      characterMemo: job.characterMemo || null, guidelines: job.guidelines.translate, profile: job.profile || null,
      totalScenes: job.scenes.length,
      model: job.settings.translateModel || job.settings.model,
    }))
    const raw = cleanOutput(res.translated)
    const parts = splitByHeading(raw)
    if (parts.length !== batch.length) { await fallback(); return } // 개수 안 맞으면 개별로
    // ★ 구조 가드: 한 파트라도 영문과 마커·줄 수가 안 맞으면 개별 경로로 (개별 경로가 재시도+에러 처리)
    if (batch.some((s, i) => !translationStructureOk(s.formatted, parts[i]))) { await fallback(); return }
    batch.forEach((s, i) => {
      const translated = parts[i]  // ★ 줄 1:1 정렬 유지 — splitGluedAction 미적용
      s.translated = translated; s.smiMatches = alignMeta(job, translated); s.batched = true
      s.tokens = { ...s.tokens, translate_in: estTokens(s.formatted), translate_out: estTokens(parts[i]) }
      s.status = 'done'
    })
  } catch (e) {
    if (e.code === 'RATE_LIMIT') rateLimitJob(job)
    if (e.code === 'AUTH' || e.code === 'CLAUDE_NOT_FOUND') haltJob(job)
    await fallback()
  }
}

// 워커 풀 (잡 내부) — 폭은 잡의 concurrency 설정 존중, 전역 슬롯(withSlot)이 총량 상한
async function runPool(job, items, fn) {
  const queue = [...items]
  const perJob = job.settings?.concurrency || 3
  const width = Math.min(perJob, GLOBAL_CAP, queue.length) || 1
  const workers = Array.from({ length: width }, async () => {
    while (queue.length) {
      const item = queue.shift()   // await 전에 선점 (워커 간 레이스 방지)
      if (item === undefined) return
      if (job.stopped) return
      await waitWhilePaused(job)
      if (job.stopped) return
      await fn(item)
      saveJob(job)
    }
  })
  await Promise.all(workers)
}

function finishStopped(job) { setRunning(job, false); job.status = 'stopped'; job.paused = false; saveJob(job, true) }

// 현재 루프가 살아있는 잡 id (메모리 전용, 미영속) — 이중 실행 방지
const activeRunners = new Set()

async function runJob(job) {
  if (activeRunners.has(job.id)) return  // 이미 워커가 도는 중이면 중복 실행 안 함
  activeRunners.add(job.id)
  job.status = 'running'; job.paused = false; job.stopped = false
  setRunning(job, true)
  saveJob(job, true)
  try {
    // 1. 포맷 (미포맷 씬만)
    job.phase = 'formatting'
    const needFormat = job.scenes.filter(s => s.status !== 'formatted' && s.status !== 'done')
    if (needFormat.length) {
      await runPool(job, needFormat, async (s) => {
        if (s.status === 'formatted' || s.status === 'done') return
        await formatScene(job, s)
      })
    }
    if (job.stopped) return finishStopped(job)

    // 1.5 인물 말투 사전 (없을 때만, 작품당 1회)
    if (!job.characterMemo && job.settings.characterRegister !== false) {
      try {
        const sample = buildDialogueSample(job.scenes)
        if (sample) {
          job.phase = 'register'; saveJob(job, true)
          // 공식 한국어 자막이 있으면 말투 근거로 함께 전달
          const subtitleSample = job.smi?.info?.lang === 'ko' ? buildSubtitleSample(job.smi.entries) : ''
          const r = await withSlot(() => handleCharacterRegister({ dialogueSample: sample, subtitleSample, model: job.settings.translateModel || job.settings.model }))
          if (r.register) job.characterMemo = r.register
        }
      } catch (e) { console.warn('말투 사전 실패(계속):', e.message) }
    }
    if (job.stopped) return finishStopped(job)

    // 1.6 작품 진단 → 처방 (없을 때만, 작품당 1회). profile이 번역 지침을 작품 성격에 맞게 조정.
    if (!job.profile && job.settings.diagnose !== false) {
      try {
        job.phase = 'diagnose'; saveJob(job, true)
        const full = job.scenes.map(s => s.formatted || s.raw || '').join('\n\n')
        const headSample = full.split('\n').filter(l => l.trim()).slice(0, 40).join('\n').slice(0, 2000)
        const subtitleSample = job.smi?.info?.lang === 'ko' ? buildSubtitleSample(job.smi.entries) : ''
        const r = await withSlot(() => handleDiagnose({ headSample, dialogueSample: buildDialogueSample(job.scenes), subtitleSample, metrics: quickMetrics(full), model: job.settings.translateModel || job.settings.model }))
        if (r.profile) job.profile = r.profile
      } catch (e) { console.warn('작품 진단 실패(처방 없이 계속):', e.message) }
    }
    if (job.stopped) return finishStopped(job)

    // 2. 번역 (미완 씬만, 짧은 씬 배칭)
    job.phase = 'translating'; saveJob(job, true)
    const pending = job.scenes.filter(s => s.formatted && s.status !== 'done')
    const batches = buildBatches(pending, job.settings.batchShort !== false)
    await runPool(job, batches, async (batch) => {
      if (batch.length === 1) await translateOne(job, batch[0])
      else await translateBatch(job, batch)
    })
    if (job.stopped) return finishStopped(job)

    // rate limit/일시정지로 멈춘 상태면 done 처리하지 않음 (이어받기 대기)
    if (job.status === 'rate_limited' || job.paused) { saveJob(job, true); return }

    job.phase = 'done'; job.status = 'done'; setRunning(job, false); job.duration = job.activeMs
    saveJob(job, true)
  } catch (e) {
    console.error('runJob error', e)
    job.status = 'error'; job.error = e.message
    saveJob(job, true)
  } finally {
    setRunning(job, false)   // 어떤 경로로 끝나도 active 시간 마감
    activeRunners.delete(job.id)
  }
}

// 잡 생성·시작
function createJob(body) {
  const { title, scenes, smi, settings, guidelines, characterMemo } = body
  if (!scenes?.length) throw new Error('scenes required')
  const id = String(Date.now())
  const job = {
    id, title: title || '제목없음', phase: 'formatting', status: 'running',
    startTime: Date.now(), duration: null, activeMs: 0,
    settings: settings || {}, guidelines: guidelines || {}, characterMemo: characterMemo || '',
    profile: null,
    smi: smi || null,
    scenes: scenes.map(s => ({
      id: s.id, raw: s.raw,
      formatted: s.formatted || null, translated: null, smiMatches: null,
      tokens: {}, status: s.status === 'formatted' ? 'formatted' : 'pending',
      error: null, heading: s.heading || null,
    })),
    paused: false, stopped: false,
  }
  if (settings?.concurrency) GLOBAL_CAP = Math.max(GLOBAL_CAP, settings.concurrency)
  jobs.set(id, job)
  saveJob(job, true)
  runJob(job)
  return { jobId: id }
}

// 잡 제어
function controlJob(id, action) {
  const job = jobs.get(id)
  if (!job) throw new Error('job not found')
  if (action === 'pause') { setRunning(job, false); job.paused = true; if (job.status === 'running') job.status = 'paused' }
  else if (action === 'resume') {
    job.paused = false; job.stopped = false
    if (job.status === 'paused' || job.status === 'rate_limited') job.status = 'running'
    setRunning(job, true)   // 재개 시 active 시간 다시 카운트 (블록된 워커는 깨우기만 해서 runJob 재진입 안 함)
    // 워커가 살아있으면(일시정지/한도대기) 깨우기만; 죽었으면(중단/오류) 새 루프 시작
    if (!activeRunners.has(id) && job.scenes.some(s => s.status !== 'done')) runJob(job)
  }
  else if (action === 'stop') { job.stopped = true; job.paused = false }
  saveJob(job, true)
  return jobMeta(job)
}

function removeJob(id) {
  const job = jobs.get(id)
  if (job) job.stopped = true
  jobs.delete(id)
  deleteJobFile(id)
  return { ok: true }
}

// 말투 가이드(글로서리) 사람이 수정
function setGlossary(id, memo) {
  const job = jobs.get(id)
  if (!job) throw new Error('job not found')
  job.characterMemo = memo || ''
  saveJob(job, true)
  return { ok: true }
}

// 작품 전체 다시 번역 — 번역만 리셋(formatted 유지). keepGlossary=false면 말투 가이드도 새로 생성.
function retranslateJob(id, keepGlossary) {
  const job = jobs.get(id)
  if (!job) throw new Error('job not found')
  if (!keepGlossary) job.characterMemo = ''
  for (const s of job.scenes) {
    s.translated = null; s.smiMatches = null; s.error = null
    s.status = s.formatted ? 'formatted' : 'pending'
  }
  job.status = 'running'; job.phase = 'formatting'; job.paused = false; job.stopped = false; job.duration = null
  saveJob(job, true)
  if (!activeRunners.has(id)) runJob(job)
  return jobMeta(job)
}

// 부팅 시 복구: jobs/ 로드 → running/rate_limited 이던 잡은 자동 재개
function loadJobsFromDisk() {
  let files = []
  try { files = readdirSync(JOBS_DIR).filter(f => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    try {
      const job = JSON.parse(readFileSync(`${JOBS_DIR}/${f}`, 'utf8'))
      job.paused = false; job.stopped = false
      // 멈춰있던 진행중 씬은 미완으로 되돌림 (재시도)
      for (const s of job.scenes) {
        if (s.status === 'formatting') s.status = 'pending'
        else if (s.status === 'translating') s.status = 'formatted'
      }
      jobs.set(job.id, job)
      if (job.status === 'running' || job.status === 'rate_limited') {
        if (job.settings?.concurrency) GLOBAL_CAP = Math.max(GLOBAL_CAP, job.settings.concurrency)
        console.log(`잡 재개: ${job.title} (${doneCount(job)}/${job.scenes.length})`)
        runJob(job)
      }
    } catch (e) { console.error('loadJob 실패', f, e.message) }
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }

  const sendJSON = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

  // --- 잡 라우트 (GET/DELETE는 본문 없이 즉시 처리) ---
  const url = req.url
  if (req.method === 'GET' && url === '/api/health') {
    return sendJSON({ ok: true, claude: !!CLAUDE_BIN, ocr: ocrToolsReady() })  // claude=false면 화면에서 설치 안내
  }
  if (req.method === 'GET' && url === '/api/jobs') {
    return sendJSON([...jobs.values()].map(jobMeta).sort((a, b) => b.startTime - a.startTime))
  }
  if (req.method === 'GET' && url.startsWith('/api/jobs/')) {
    const id = url.slice('/api/jobs/'.length)
    const job = jobs.get(id)
    return job ? sendJSON(job) : sendJSON({ error: 'job not found' }, 404)
  }
  if (req.method === 'DELETE' && url.startsWith('/api/jobs/')) {
    const id = url.slice('/api/jobs/'.length)
    return sendJSON(removeJob(id))
  }

  if (req.method !== 'POST') { res.writeHead(405).end(); return }

  let body = ''
  req.on('data', d => body += d)
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {}
      let result

      // 잡 POST 라우트
      const mCtrl = url.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|stop)$/)
      const mGloss = url.match(/^\/api\/jobs\/([^/]+)\/glossary$/)
      const mRetrans = url.match(/^\/api\/jobs\/([^/]+)\/retranslate$/)
      if (url === '/api/jobs') result = createJob(data)
      else if (mGloss) result = setGlossary(mGloss[1], data.memo)
      else if (mRetrans) result = retranslateJob(mRetrans[1], data.keepGlossary)
      else if (mCtrl) result = controlJob(mCtrl[1], mCtrl[2])
      else if (req.url === '/api/character-register') result = await handleCharacterRegister(data)
      else if (req.url === '/api/diagnose') result = await handleDiagnose(data)
      else if (req.url === '/api/format') result = await handleFormat(data)
      else if (req.url === '/api/translate') result = await handleTranslate(data)
      else if (req.url === '/api/revise') result = await handleRevise(data)
      else if (req.url === '/api/patch') result = await handlePatch(data)
      else if (req.url === '/api/detect-headings') result = await handleDetectHeadings(data)
      else if (req.url === '/api/load-prompts') result = handleLoadPrompts()
      else if (req.url === '/api/save-prompts') result = handleSavePrompts(data)
      else if (req.url === '/api/load-glossary') result = handleLoadGlossary()
      else if (req.url === '/api/save-glossary') result = handleSaveGlossary(data)
      else if (req.url === '/api/log') result = handleLog(data)
      else if (req.url === '/api/fix-feedback') result = await handleFixFeedback(data)
      else if (req.url === '/api/ocr') result = await handleOcr(data)
      else { res.writeHead(404).end(); return }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (e) {
      console.error(e)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message, code: e.code || null }))
    }
  })
})

server.listen(PORT, () => {
  console.log(`server running on http://localhost:${PORT}`)
  loadJobsFromDisk()  // 재시작/크래시/sleep 후 진행 중이던 잡 자동 재개
})
