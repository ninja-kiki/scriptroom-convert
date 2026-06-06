// 규칙 기반 수정 + LLM 서전 패치

const CHUNK_WINDOW = 14 // 문제 구간 앞뒤 줄 수

// 파일 타입 자동 인식
export function detectFileType(text) {
  const hasKoreanHeading = /^#\s*(내부|외부|삽입)/m.test(text)
  const koreanRatio = (text.match(/[가-힣]/g) || []).length / text.length
  return (hasKoreanHeading || koreanRatio > 0.1) ? 'translated' : 'formatted'
}

// 규칙 기반 이슈 감지
export function detectIssues(text) {
  const issues = []

  const creditOld = (text.match(/\[크레딧:/g) || []).length
  if (creditOld > 0) issues.push({ id: 'marker_credit', auto: true, label: '[크레딧:] → [CREDIT:] 변환', count: creditOld })

  const superOld = (text.match(/\[자막:/g) || []).length
  if (superOld > 0) issues.push({ id: 'marker_super', auto: true, label: '[자막:] → [SUPER:] 변환', count: superOld })

  const blankCount = countMissingBlankLines(text)
  if (blankCount > 0) issues.push({ id: 'blank_lines', auto: true, label: '대사 뒤 빈 줄 삽입', count: blankCount })

  const headingCount = (text.match(/^(?!# )(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/gm) || []).length
  if (headingCount > 0) issues.push({ id: 'heading_hash', auto: true, label: '씬 헤딩 # 마커 추가', count: headingCount })

  return issues
}

// 사용자 지시사항 기반 LLM 청크 계획
export function planLLMChunks(text, userInstruction) {
  if (!userInstruction?.trim()) return []
  const lines = text.split('\n')
  // 씬 헤딩 기준으로 섹션 분리, 각 섹션을 청크로
  const chunks = []
  let start = 0
  for (let i = 1; i <= lines.length; i++) {
    const isHeading = lines[i]?.trim().startsWith('#') || i === lines.length
    if (isHeading && i - start > 2) {
      chunks.push({ startLine: start, endLine: i - 1, lines: lines.slice(start, i) })
      start = i
    }
  }
  // 너무 큰 청크는 분할 (30줄 이상)
  const result = []
  for (const chunk of chunks) {
    if (chunk.lines.length <= 30) {
      result.push(chunk)
    } else {
      // 30줄씩 분할
      for (let i = 0; i < chunk.lines.length; i += 25) {
        const slice = chunk.lines.slice(i, i + 25)
        result.push({ startLine: chunk.startLine + i, endLine: chunk.startLine + i + slice.length - 1, lines: slice })
      }
    }
  }
  return result
}

// 토큰 예상량 계산 (청크 수 × 평균 토큰)
export function estimateTokens(chunks) {
  const avgTokensPerLine = 15
  return chunks.reduce((sum, c) => sum + c.lines.length * avgTokensPerLine * 2, 0)
}

// 규칙 기반 자동 수정 적용
export function applyAutoFixes(text, selectedIds) {
  let result = text
  if (selectedIds.includes('marker_credit')) result = result.replace(/\[크레딧:/g, '[CREDIT:')
  if (selectedIds.includes('marker_super')) result = result.replace(/\[자막:/g, '[SUPER:')
  if (selectedIds.includes('blank_lines')) result = fixBlankLines(result)
  if (selectedIds.includes('heading_hash')) result = result.replace(/^(?!# )(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/gm, '# $1')
  return result
}

// LLM 패치 결과를 원본 텍스트에 끼워넣기
export function patchText(originalText, patchResults) {
  const lines = originalText.split('\n')
  // 뒤에서부터 패치 (앞에서 패치하면 라인 번호 틀어짐)
  const sorted = [...patchResults].sort((a, b) => b.startLine - a.startLine)
  for (const { startLine, endLine, patched } of sorted) {
    const patchedLines = patched.split('\n')
    lines.splice(startLine, endLine - startLine + 1, ...patchedLines)
  }
  return lines.join('\n')
}

// --- 내부 함수 ---

function countMissingBlankLines(text) {
  const lines = text.split('\n')
  let count = 0, inDialogue = false
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i].trim(), next = lines[i + 1].trim()
    if (cur.startsWith('@')) { inDialogue = true; continue }
    if (cur === '' || cur.startsWith('#')) { inDialogue = false; continue }
    if (cur.startsWith('(') || cur.startsWith('[')) continue
    if (inDialogue && cur !== '' && next !== '' && !next.startsWith('@') && !next.startsWith('(') && !next.startsWith('#') && !next.startsWith('[')) {
      count++; inDialogue = false
    }
  }
  return count
}

function fixBlankLines(text) {
  const lines = text.split('\n'), result = []
  let inDialogue = false
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i].trim(), next = lines[i + 1]?.trim() ?? ''
    result.push(lines[i])
    if (cur.startsWith('@')) { inDialogue = true; continue }
    if (cur === '' || cur.startsWith('#')) { inDialogue = false; continue }
    if (cur.startsWith('(') || cur.startsWith('[')) continue
    if (inDialogue && cur !== '' && next !== '' && !next.startsWith('@') && !next.startsWith('(') && !next.startsWith('#') && !next.startsWith('[')) {
      result.push(''); inDialogue = false
    }
  }
  return result.join('\n')
}
