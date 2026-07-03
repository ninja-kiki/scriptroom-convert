// Client-side text extraction: PDF (pdfjs), RTF (strip tags), FDX (strip XML), TXT (as-is)
import * as pdfjsLib from 'pdfjs-dist'
// 로컬 번들 워커 (CDN 의존 제거 → "불러오는중" 멈춤 방지, 오프라인 OK)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// 볼드 효과를 텍스트 레이어에 다중으로 그린 PDF(스파이더맨 류) — 한 줄 안 동일 문자열 반복을 1회로 접음.
// "EXT. HOUSE - DAYEXT. HOUSE - DAY...1111" → "EXT. HOUSE - DAY1". 접힌 경우에만 꼬리 동일숫자 다발도 접음(연도 2000 등 보호).
export function collapseRepeats(orig) {
  let s = orig, prev
  do { prev = s; s = s.replace(/(.{6,}?)\1{2,}/g, '$1') } while (s !== prev)
  return s !== orig ? s.replace(/(\d)\1{2,}\s*$/, '$1') : s
}

export async function extractTextFromPDF(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const totalPages = pdf.numPages
  const pages = []          // 페이지별 [{text, x}]

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
          pageLines.push({ text: collapseRepeats(lineText), x: lineMinX })
          lineText = ''; lineMinX = Infinity
        }
        if (!lineText.trim()) lineMinX = Math.min(lineMinX, x)
        lineText += item.str
        lastY = y
      }
    }
    if (lineText.trim()) pageLines.push({ text: collapseRepeats(lineText), x: lineMinX })
    pages.push(pageLines)
    onProgress?.(i, totalPages)
  }

  // ── 반복 머리말/꼬리말 제거 ──────────────────────────────
  // 페이지 가장자리(상·하단 2줄)에서, 숫자·날짜를 뺀 시그니처가 여러 페이지에 반복되면
  // 러닝헤더/푸터로 판단해 제거. (작품명+페이지번호, "FULL Salmon Draft [101] 5/6/22" 등)
  const sig = (t) => t.trim().toLowerCase()
    .replace(/\d+/g, ' ')
    .replace(/[[\]().,/'"“”\-–—:!?]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  const edgeCount = new Map()
  for (const pageLines of pages) {
    const n = pageLines.length
    const seen = new Set()
    pageLines.forEach((l, idx) => {
      if (idx < 2 || idx >= n - 2) {
        const s = sig(l.text)
        if (s.length >= 3 && !seen.has(s)) { seen.add(s); edgeCount.set(s, (edgeCount.get(s) || 0) + 1) }
      }
    })
  }
  const threshold = Math.max(3, Math.ceil(totalPages * 0.2))
  const boiler = new Set([...edgeCount].filter(([, c]) => c >= threshold).map(([s]) => s))

  // ── 최종 줄 + 헤딩 후보 (보일러플레이트 제외) ──────────────
  // 들여쓰기 보존: 각본은 x좌표(왼쪽여백=지문, 들여쓰기=대사, 더 깊이=인물 큐)가 곧 구조다.
  // x를 앞 공백으로 환산해 남겨야 포맷터(규칙·LLM)가 대사/지문을 안 헷갈린다 — 버리면 대사·지문이 붙는 근본 원인.
  let minX = Infinity
  for (const pl of pages) for (const l of pl) if (l.x < minX && l.text.trim()) minX = l.x
  if (!isFinite(minX)) minX = 0
  const indentOf = (x) => ' '.repeat(Math.max(0, Math.min(40, Math.round((x - minX) / 7))))   // ~7px = 공백 1칸(모노스페이스)

  const allLines = []
  const candidates = []
  for (const pageLines of pages) {
    const n = pageLines.length
    pageLines.forEach((l, i) => {
      const isEdge = i < 2 || i >= n - 2
      if (isEdge && boiler.has(sig(l.text))) return   // 러닝헤더/푸터 제거

      const idx = allLines.length
      allLines.push(indentOf(l.x) + l.text.trim())

      const t = l.text.trim(), x = l.x
      if (x < 130 && t.length >= 5 && t.length <= 75) {
        const letters = t.replace(/[^a-zA-Z]/g, '')
        if (letters.length >= 3 && t.replace(/[^A-Z]/g, '').length / letters.length > 0.7) {
          if (!/^(FADE|CUT TO|DISSOLVE|MATCH CUT|OMITTED|THE END|CONTINUED|CONT'D|MORE\b)/i.test(t) && !t.endsWith(':')) {
            candidates.push({ idx, text: t })
          }
        }
      }
    })
  }

  return { text: allLines.join('\n'), candidates }
}

// 씬 헤딩 없이 짧거나 크레딧 신호만 있는 청크(표지·타이틀 페이지)를 걸러냄
function looksLikeTitlePage(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const hasHeading = lines.some(l =>
    /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(l) ||
    /^(INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i.test(l)
  )
  if (hasHeading) return false
  const hasTitleSignal = lines.some(l =>
    /^(FADE IN|FADE OUT|written by|screenplay by|an original|based on|a film by)/i.test(l)
  )
  return lines.length < 15 || hasTitleSignal
}

// INT./EXT. 없는 "장소 - 시간대" 슬러그라인 감지 (라따뚜이·픽사식 비표준 헤딩)
// 예: "FRENCH COUNTRYSIDE - LATE AFTERNOON", "FARMHOUSE - COMPOST PILE - DAY"
// 시간대 단어로 끝나는 대문자 줄만 → "A TELEVISION SET" 같은 대문자 지문은 안 걸림
const SLUG_TIME = /\b(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|NOON|MIDNIGHT|CONTINUOUS|LATER|EARLIER|MOMENTS|SAME|SUNSET|SUNRISE)\b/
export function looksLikeSlugline(line) {
  const s = (line || '').trim()
  if (s.length < 5 || s.length > 70) return false
  if (!/\s[-–—]\s/.test(s)) return false                       // "장소 - 시간" 구분자 필수
  const letters = s.replace(/[^A-Za-z]/g, ''), upper = s.replace(/[^A-Z]/g, '')
  if (letters.length < 3 || upper.length / letters.length < 0.85) return false  // 거의 전부 대문자
  return SLUG_TIME.test(s.split(/\s[-–—]\s/).pop())            // 마지막 구획이 시간대
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
    // OCR 잡티/씬번호 제거판: 앞쪽 짧은 토큰(f*, \, ', I, 1 등)+공백 다발을 떼고 한 번 더 본다
    const deSpeck = trimmed.replace(/^[A-Za-z0-9*'"\\\/|.\-]{1,3}\s{2,}/, '')
    const headMatch = (s) =>
      /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(s) ||
      /^[A-Z]?\d+\.?\s+(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(s) ||
      /^SCENE\s+\d+\s*[-–.]/i.test(s) ||
      /^(INSERT|INTERCUT WITH|MONTAGE|SERIES OF SHOTS)/i.test(s) ||
      looksLikeSlugline(s)   // INT./EXT. 없는 "장소 - 시간대" 헤딩 (라따뚜이식)
    // 씬 헤딩 감지: INT./EXT. LOCATION, 씬번호 prefix(19/A19), SCENE N -, INSERT/INTERCUT, 장소-시간 슬러그
    const isHeading = headMatch(trimmed) || headMatch(deSpeck)

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

  // 타이틀/표지 페이지 제거: 씬 헤딩이 없고 짧거나 크레딧 신호가 있는 청크
  const filtered = scenes.filter(s => !looksLikeTitlePage(s.raw))
  const base = filtered.length > 0 ? filtered : scenes  // 전부 걸리면 원본 유지
  return base.map((s, i) => ({ id: i, raw: s.raw }))
}

// 처리 단계용: 긴 논리적 씬을 80줄 청크로 분할 (씬 목록 표시엔 안 씀)
export function forceSplitScenes(scenes, max = MAX_SCENE_LINES) {
  const result = []
  let n = 0
  for (const sc of scenes) {
    const lines = sc.raw.split('\n')
    if (lines.length <= max) {
      result.push({ ...sc, id: n++ })
    } else {
      for (let i = 0; i < lines.length; i += max) {
        // 첫 조각(i===0)은 그 씬 자체 → 번호(#n)를 받음. 이어지는 조각만 forceSplit=이어짐(↳).
        result.push({
          ...sc, id: n++, raw: lines.slice(i, i + max).join('\n'), forceSplit: i > 0,
          formatted: null, translated: null, tokens: null, error: null, heading: null,
          status: sc.status === undefined ? undefined : 'pending',
        })
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

// 스캔 PDF → 서버 OCR (pdftoppm + tesseract, 로컬·토큰 0). 텍스트 레이어가 비었을 때만 호출.
export async function ocrPdfViaServer(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk))
  const pdfBase64 = btoa(bin)
  const res = await fetch('/api/ocr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfBase64 }),
  })
  if (!res.ok) {
    let msg = 'OCR 실패', code = null
    try { const j = await res.json(); msg = j.error || msg; code = j.code } catch {}
    const e = new Error(msg); e.ocrMissing = code === 'OCR_TOOLS_MISSING'; throw e
  }
  return (await res.json()).text || ''
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

  // 논리적 씬만 반환 (80줄 강제분할은 처리 단계 forceSplitScenes에서)
  return scenes.map((s, i) => ({ id: i, raw: s.raw }))
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
