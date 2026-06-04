import { createServer } from 'http'
import { spawn, execSync } from 'child_process'
import { readdirSync } from 'fs'

const PORT = 3001

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
    const proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'text'], {
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
  const { formattedText, smiContext, characterMemo, guidelines, sceneIndex, totalScenes, targetLang } = body
  if (!formattedText) throw new Error('formattedText required')

  const smiSection = smiContext ? `\n\n[참고 자막 (해당 씬 인근)]\n${smiContext}` : ''
  const memoSection = characterMemo ? `\n\n[인물 관계 메모]\n${characterMemo}` : ''
  const lang = targetLang || '한국어'

  const systemPrompt = `당신은 영화 각본 번역가입니다. 포맷된 각본 텍스트를 ${lang}로 번역하세요.

지침:
${guidelines}${memoSection}${smiSection}

중요: JSON이 아닌 순수 텍스트로만 응답하세요. 번역된 각본 텍스트만 출력하세요.`

  const userPrompt = `다음 포맷된 각본을 번역하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${formattedText}`

  const translated = await runClaude(systemPrompt, userPrompt)
  return { translated, tokens: null }
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
