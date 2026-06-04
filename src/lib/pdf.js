// Client-side text extraction: PDF (pdfjs), RTF (strip tags), FDX (strip XML), TXT (as-is)
import * as pdfjsLib from 'pdfjs-dist'

// Use CDN worker to avoid bundling issues
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

export async function extractTextFromPDF(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const totalPages = pdf.numPages
  const pages = []

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    // Join items preserving line breaks (items with different y have newline)
    let lastY = null
    let lines = []
    let line = ''
    for (const item of content.items) {
      if ('str' in item) {
        const y = item.transform?.[5]
        if (lastY !== null && Math.abs(y - lastY) > 2 && line.trim()) {
          lines.push(line)
          line = ''
        }
        line += item.str
        lastY = y
      }
    }
    if (line.trim()) lines.push(line)
    pages.push(lines.join('\n'))
    onProgress?.(i, totalPages)
  }

  return pages.join('\n')
}

// Split raw PDF text into rough scenes by INT./EXT. headings
export function splitIntoScenes(rawText) {
  const lines = rawText.split('\n')
  const scenes = []
  let current = []
  let sceneNum = 0

  for (const line of lines) {
    const trimmed = line.trim()
    // Detect scene heading: starts with INT., EXT., INT./EXT., I/E.
    if (/^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)/i.test(trimmed) && trimmed.length > 5) {
      if (current.length > 0) {
        scenes.push({ id: sceneNum++, raw: current.join('\n') })
      }
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) {
    scenes.push({ id: sceneNum++, raw: current.join('\n') })
  }

  // If no scenes detected (no INT./EXT.), treat entire text as one chunk
  if (scenes.length === 0) {
    return [{ id: 0, raw: rawText }]
  }

  return scenes
}

function stripRtf(text) {
  return text
    .replace(/\\[a-z*]+[\d-]* ?/g, '')
    .replace(/[{}\\]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripXml(text) {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, '\n').trim()
}

export async function extractText(file, onProgress) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext === 'pdf') return extractTextFromPDF(file, onProgress)
  const text = await file.text()
  if (ext === 'rtf') return stripRtf(text)
  if (ext === 'fdx' || ext === 'xml') return stripXml(text)
  return text // txt, fountain, etc.
}

// Parse SMI file into plain text segments for context
export function parseSMI(text) {
  // Strip SAMI tags, extract dialogue
  const cleaned = text
    .replace(/<SYNC[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r/g, '')
  return cleaned.split('\n').map(l => l.trim()).filter(Boolean).join('\n')
}
