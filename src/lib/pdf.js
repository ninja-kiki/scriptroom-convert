// Client-side text extraction: PDF (pdfjs), RTF (strip tags), FDX (strip XML), TXT (as-is)
import * as pdfjsLib from 'pdfjs-dist'
// 로컬 번들 워커 (CDN 의존 제거 → "불러오는중" 멈춤 방지, 오프라인 OK)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export async function extractTextFromPDF(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const totalPages = pdf.numPages
  const allLines = []       // 전체 줄 텍스트 (순서 유지)
  const candidates = []     // 씬 헤딩 후보: { idx, text }

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()

    let lastY = null
    let lineText = ''
    let lineMinX = Infinity   // 이 줄의 첫 글자 x 좌표 (좌측 여백 판별)
    const pageLines = []

    for (const item of content.items) {
      if ('str' in item) {
        const y = item.transform?.[5]
        const x = item.transform?.[4] ?? Infinity
        if (lastY !== null && Math.abs(y - lastY) > 2 && lineText.trim()) {
          pageLines.push({ text: lineText, x: lineMinX })
          lineText = ''; lineMinX = Infinity
        }
        if (!lineText.trim()) lineMinX = Math.min(lineMinX, x)
        lineText += item.str
        lastY = y
      }
    }
    if (lineText.trim()) pageLines.push({ text: lineText, x: lineMinX })

    for (const { text, x } of pageLines) {
      const idx = allLines.length
      allLines.push(text)

      // 씬 헤딩 후보 조건:
      // - 좌측 여백 (x < 130pt ≈ 대부분 각본 포맷에서 씬 헤딩/지문 위치)
      // - 5~75자, 대문자 70% 이상
      // - 명백한 비헤딩 제외
      const t = text.trim()
      if (x < 130 && t.length >= 5 && t.length <= 75) {
        const letters = t.replace(/[^a-zA-Z]/g, '')
        if (letters.length >= 3 && t.replace(/[^A-Z]/g, '').length / letters.length > 0.7) {
          if (!/^(FADE|CUT TO|DISSOLVE|MATCH CUT|OMITTED|THE END|CONTINUED|CONT'D|MORE\b)/i.test(t) && !t.endsWith(':')) {
            candidates.push({ idx, text: t })
          }
        }
      }
    }

    onProgress?.(i, totalPages)
  }

  return { text: allLines.join('\n'), candidates }
}

// Split raw PDF text into rough scenes by INT./EXT. headings
const MAX_SCENE_LINES = 80 // 이 이상이면 강제 분할

export function splitIntoScenes(rawText) {
  // 페이지 마커 제거 (Page 40/130, p.40 등)
  const cleaned = rawText
    .replace(/^Page\s+\d+\/\d+\s*$/gim, '')
    .replace(/^\s*\d+\.\s*$/gm, '') // 독립된 페이지 번호 줄

  const lines = cleaned.split('\n')
  const scenes = []
  let current = []
  let sceneNum = 0

  for (const line of lines) {
    const trimmed = line.trim()
    // 씬 헤딩 감지 (다양한 형식 지원):
    // INT./EXT. LOCATION
    // 19 EXT. LOCATION (씬 번호 prefix)
    // 19. EXT. LOCATION (점 있는 prefix)
    // A19 EXT. LOCATION (알파벳+숫자 prefix)
    // SCENE 1 - INT. LOCATION
    // INSERT / INTERCUT / MONTAGE
    const isHeading =
      /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(trimmed) ||
      /^[A-Z]?\d+\.?\s+(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(trimmed) ||
      /^SCENE\s+\d+\s*[-–.]/i.test(trimmed) ||
      /^(INSERT|INTERCUT WITH|MONTAGE|SERIES OF SHOTS)/i.test(trimmed)

    if (isHeading && trimmed.length > 5) {
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

  // If no scenes detected, treat entire text as one chunk
  if (scenes.length === 0) {
    return [{ id: 0, raw: rawText }]
  }

  // 너무 큰 씬은 강제 분할 (출력 토큰 초과 방지)
  const result = []
  let finalNum = 0
  for (const scene of scenes) {
    const sceneLines = scene.raw.split('\n')
    if (sceneLines.length <= MAX_SCENE_LINES) {
      result.push({ id: finalNum++, raw: scene.raw })
    } else {
      for (let i = 0; i < sceneLines.length; i += MAX_SCENE_LINES) {
        result.push({ id: finalNum++, raw: sceneLines.slice(i, i + MAX_SCENE_LINES).join('\n'), forceSplit: true })
      }
    }
  }

  return result
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
  // PDF 아닌 파일: candidates 없이 동일 형태로 반환
  let text = await file.text()
  if (ext === 'rtf') text = stripRtf(text)
  else if (ext === 'fdx' || ext === 'xml') text = stripXml(text)
  return { text, candidates: [] }
}

// 한 줄이 씬 헤딩처럼 보이는가 (LLM 오탐 필터용)
export function isLikelyHeading(line) {
  const s = (line || '').trim()
  if (!s || s.length < 4) return false
  if (/^Page\s+\d+/i.test(s)) return false                                   // 페이지 마커
  if (/^[A-Z]{0,2}\d+[.\/]?\d*$/.test(s)) return false                       // 단독 숫자/씬번호 (B10 등)
  if (/^[A-Z][A-Za-z0-9 .'\-/]{0,28}\s*[:：]\s*$/.test(s)) return false       // 캐릭터 큐 "DARBY :"
  if (/^(CUT TO|FADE|DISSOLVE|SMASH CUT|MATCH CUT|TITLE|THE END|OMITTED)/i.test(s)) return false // 전환/기타
  if (/(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(s)) return true  // 표준 헤딩
  if (/^([A-Z]{0,2}\d+\.?\s+)?(SCENE\s+\d+|INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i.test(s)) return true
  // 비표준 장소 헤딩: 짧고 대문자 비중 높음
  const letters = s.replace(/[^A-Za-z]/g, ''), upper = s.replace(/[^A-Z]/g, '')
  return s.length <= 55 && letters.length >= 3 && upper.length / letters.length > 0.7
}

// LLM이 반환한 헤딩 줄 인덱스 배열로 씬 분할
export function splitByHeadingIndices(rawText, headingIndices) {
  const lines = rawText.split('\n')
  const indexSet = new Set(headingIndices)
  const scenes = []
  let current = []
  let num = 0

  for (let i = 0; i < lines.length; i++) {
    if (indexSet.has(i) && current.length > 0) {
      scenes.push({ id: num++, raw: current.join('\n') })
      current = []
    }
    current.push(lines[i])
  }
  if (current.length > 0) scenes.push({ id: num++, raw: current.join('\n') })
  if (scenes.length === 0) return [{ id: 0, raw: rawText }]

  // 80줄 초과 씬 강제 분할
  const result = []
  let finalNum = 0
  for (const scene of scenes) {
    const sl = scene.raw.split('\n')
    if (sl.length <= MAX_SCENE_LINES) {
      result.push({ id: finalNum++, raw: scene.raw })
    } else {
      for (let i = 0; i < sl.length; i += MAX_SCENE_LINES) {
        result.push({ id: finalNum++, raw: sl.slice(i, i + MAX_SCENE_LINES).join('\n'), forceSplit: true })
      }
    }
  }
  return result
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
