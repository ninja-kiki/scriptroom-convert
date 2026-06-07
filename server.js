import { createServer } from 'http'
import { spawn, execSync } from 'child_process'
import { readdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'

const PORT = 3001
const PROMPTS_PATH = `${process.cwd()}/prompts.json`

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

  throw new Error('claude CLI를 찾을 수 없습니다. Claude Code가 설치되어 있는지 확인하세요.')
}

const CLAUDE_BIN = findClaude()

function runClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
    const proc = spawn(CLAUDE_BIN, ['-p'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    proc.stdout.on('data', d => out += d)
    proc.stderr.on('data', d => err += d)
    proc.on('close', code => {
      if (code !== 0) {
        console.error('claude stderr:', err)
        console.error('claude stdout:', out)
        const combined = (err + out).toLowerCase()
        if (combined.includes('rate limit') || combined.includes('usage limit') || combined.includes('too many') || combined.includes('quota')) {
          const e = new Error('RATE_LIMIT')
          e.code = 'RATE_LIMIT'
          reject(e)
        } else {
          reject(new Error(err || out || `exit code ${code}`))
        }
      } else resolve(out.trim())
    })
    proc.stdin.write(fullPrompt)
    proc.stdin.end()
  })
}

async function handleFormat(body) {
  const { sceneText, guidelines, sceneIndex, totalScenes } = body
  if (!sceneText) throw new Error('sceneText required')

  const systemPrompt = `당신은 영화 각본 포매터입니다. 원본 각본 텍스트를 받아 지정된 형식으로 변환하세요.

지침:
${guidelines}

중요: JSON이 아닌 순수 텍스트로만 응답하세요. 설명이나 주석 없이 변환된 각본 텍스트만 출력하세요.`

  const userPrompt = `다음 각본 텍스트를 포맷하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${sceneText}`

  const formatted = await runClaude(systemPrompt, userPrompt)
  return { formatted, tokens: null }
}

async function handleTranslate(body) {
  const { formattedText, smiContext, characterMemo, guidelines, sceneIndex, totalScenes, targetLang, prevTail } = body
  if (!formattedText) throw new Error('formattedText required')

  const smiSection = smiContext ? `\n\n[참고 자막 (해당 씬 인근)]\n${smiContext}` : ''
  const memoSection = characterMemo ? `\n\n[인물 관계 메모]\n${characterMemo}` : ''
  const prevSection = prevTail ? `\n\n[직전 장면 끝부분 — 대명사·상황 맥락 참고용. 번역하지 말 것]\n${prevTail}` : ''
  const lang = targetLang || '한국어'

  const systemPrompt = `당신은 영화 각본 번역가입니다. 포맷된 각본 텍스트를 ${lang}로 번역하세요.

지침:
${guidelines}${memoSection}${prevSection}${smiSection}

중요: JSON이 아닌 순수 텍스트로만 응답하세요. 번역된 각본 텍스트만 출력하세요.`

  const userPrompt = `다음 포맷된 각본을 번역하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${formattedText}`

  const translated = await runClaude(systemPrompt, userPrompt)
  return { translated, tokens: null }
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
  const { ko, en, note, guidelines } = body
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
  const fixed = await runClaude(systemPrompt, userPrompt)
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
  const { sceneText, guidelines, mode, sceneIndex, totalScenes } = body
  if (!sceneText) throw new Error('sceneText required')

  const modeLabel = mode === 'translated' ? '번역된 각본' : '포맷된 각본'
  const systemPrompt = `당신은 영화 각본 교정 전문가입니다. 이미 처리된 ${modeLabel} 텍스트를 받아 아래 지침에 맞게 수정하세요.

지침:
${guidelines}

중요: 수정된 텍스트만 출력하세요. 설명이나 주석 없이 순수 텍스트로만 응답하세요.`

  const userPrompt = `다음 ${modeLabel}을 지침에 맞게 수정하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${sceneText}`

  const revised = await runClaude(systemPrompt, userPrompt)
  return { revised, tokens: null }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }

  if (req.method !== 'POST') { res.writeHead(405).end(); return }

  let body = ''
  req.on('data', d => body += d)
  req.on('end', async () => {
    try {
      const data = JSON.parse(body)
      let result

      if (req.url === '/api/format') result = await handleFormat(data)
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

server.listen(PORT, () => console.log(`server running on http://localhost:${PORT}`))
