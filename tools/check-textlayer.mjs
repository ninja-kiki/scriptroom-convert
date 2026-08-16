// PDF가 '원래 텍스트로 만들어진 것'인지 '스캔 이미지에 OCR을 심은 것'인지 판별한다.
//   번역에 돈을 쓰기 전에 원본 종류를 알아야 한다.
//   판별 근거(추측이 아니라 파일 구조):
//     ① 쪽을 덮는 큰 이미지가 있는가        → 스캔본
//     ② 글꼴 이름이 OCR 산물 특유인가        → GlyphLessFont 등은 Tesseract가 심은 투명 레이어
//     ③ 쪽당 텍스트 조각이 거의 없는가       → 텍스트 레이어 자체가 없음(진짜 OCR 필요)
//   사용: node tools/check-textlayer.mjs <PDF...>
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync } from 'fs'
import { basename } from 'path'

for (const path of process.argv.slice(2)) {
  let pdf
  try { pdf = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise } catch { console.log(`${basename(path).padEnd(46)} 열기 실패`); continue }
  const N = pdf.numPages
  const probe = [...new Set([2, Math.ceil(N * 0.35), Math.ceil(N * 0.7)].filter(p => p >= 1 && p <= N))]

  let items = 0, imgPages = 0
  const fonts = new Set()
  for (const p of probe) {
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    items += tc.items.length
    for (const it of tc.items) if (it.fontName) fonts.add(it.fontName)
    try {
      const ops = await page.getOperatorList()
      // 쪽 전체를 덮는 이미지 = 스캔 페이지
      if (ops.fnArray.some(fn => fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject)) imgPages++
    } catch {}
  }
  const perPage = Math.round(items / probe.length)

  // 글꼴 실명 확인 — OCR이 심은 레이어는 글꼴이 없거나 GlyphLess 계열
  const fontNames = []
  for (const f of fonts) {
    try { const o = pdf.commonObjs.has(f) ? pdf.commonObjs.get(f) : null; if (o?.name) fontNames.push(o.name) } catch {}
  }
  const ocrFont = fontNames.some(n => /glyphless|invisible|ocr/i.test(n))
  const imgRatio = imgPages / probe.length

  let verdict, action
  if (perPage < 5) { verdict = '텍스트 레이어 없음'; action = '진짜 OCR 필요 — 품질 보장 못 함' }
  else if (ocrFont) { verdict = 'OCR이 심은 레이어(글꼴 확인)'; action = '청소 후 사용 가능, 고유명사 주의' }
  else if (imgRatio >= 0.6) { verdict = '스캔 이미지 + 텍스트'; action = '청소 후 사용 가능, 고유명사 주의' }
  else { verdict = '원본 텍스트 PDF'; action = '그대로 사용' }

  console.log(`${basename(path).slice(0, 42).padEnd(44)} ${String(N).padStart(4)}쪽 · 조각/쪽 ${String(perPage).padStart(5)} · 이미지쪽 ${imgPages}/${probe.length} · ${verdict.padEnd(22)} ${action}`)
}
