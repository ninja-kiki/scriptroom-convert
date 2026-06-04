import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { sceneText, guidelines, sceneIndex, totalScenes, model } = req.body

  if (!sceneText) return res.status(400).json({ error: 'sceneText required' })

  const systemPrompt = `당신은 영화 각본 포매터입니다. 원본 각본 텍스트를 받아 지정된 형식으로 변환하세요.

지침:
${guidelines}

중요: JSON이 아닌 순수 텍스트로만 응답하세요. 설명이나 주석 없이 변환된 각본 텍스트만 출력하세요.`

  const userPrompt = `다음 각본 텍스트를 포맷하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${sceneText}`

  try {
    const msg = await client.messages.create({
      model: model || 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const formatted = msg.content[0].text
    const tokens = {
      input: msg.usage.input_tokens,
      output: msg.usage.output_tokens
    }

    res.json({ formatted, tokens })
  } catch (e) {
    console.error('format error', e)
    res.status(500).json({ error: e.message })
  }
}
