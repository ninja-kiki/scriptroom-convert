import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { formattedText, smiContext, characterMemo, guidelines, sceneIndex, totalScenes, model, targetLang } = req.body

  if (!formattedText) return res.status(400).json({ error: 'formattedText required' })

  const smiSection = smiContext ? `\n\n[참고 자막 (해당 씬 인근)]\n${smiContext}` : ''
  const memoSection = characterMemo ? `\n\n[인물 관계 메모]\n${characterMemo}` : ''

  const lang = targetLang || '한국어'
  const systemPrompt = `당신은 영화 각본 번역가입니다. 포맷된 각본 텍스트를 ${lang}로 번역하세요.

지침:
${guidelines}${memoSection}${smiSection}

중요: JSON이 아닌 순수 텍스트로만 응답하세요. 번역된 각본 텍스트만 출력하세요.`

  const userPrompt = `다음 포맷된 각본을 번역하세요${totalScenes ? ` (씬 ${sceneIndex + 1}/${totalScenes})` : ''}:

${formattedText}`

  try {
    const msg = await client.messages.create({
      model: model || 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const translated = msg.content[0].text
    const tokens = {
      input: msg.usage.input_tokens,
      output: msg.usage.output_tokens
    }

    res.json({ translated, tokens })
  } catch (e) {
    console.error('translate error', e)
    res.status(500).json({ error: e.message })
  }
}
