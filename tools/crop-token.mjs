// 의심 토큰이 있는 PDF 자리를 잘라 이미지로 만든다 — 사람이 원본을 눈으로 보고 판별하도록.
//   OCR이 무엇으로 읽었든, 사람은 실제 인쇄된 글자를 보면 바로 안다.
//   사용: node tools/crop-token.mjs <PDF> <토큰> [출력.png]
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const [pdfPath, token, outPath = '/tmp/crop.png'] = process.argv.slice(2)
if (!pdfPath || !token) { console.error('사용: node tools/crop-token.mjs <PDF> <토큰> [출력.png]'); process.exit(1) }

const pdf = await getDocument({ data: new Uint8Array(readFileSync(pdfPath)) }).promise
let hit = null
for (let p = 1; p <= pdf.numPages && !hit; p++) {
  const page = await pdf.getPage(p)
  const tc = await page.getTextContent()
  for (const it of tc.items) {
    if (!it.str.includes(token)) continue
    const vp = page.getViewport({ scale: 1 })
    hit = { page: p, x: it.transform[4], y: it.transform[5], w: it.width || 60, h: it.height || 12, pw: vp.width, ph: vp.height }
    break
  }
}
if (!hit) { console.error(`'${token}' 를 못 찾음`); process.exit(2) }

const DPI = 200, S = DPI / 72
// 앞뒤 문맥이 보이도록 넉넉히 — 좌우로 넓게, 위아래로 두어 줄
const padX = 240, padY = 26
const left = Math.max(0, (hit.x - padX) * S)
const top = Math.max(0, (hit.ph - hit.y - padY) * S)
const w = Math.min((hit.w + padX * 2) * S, hit.pw * S - left)
const h = Math.min((padY * 2 + hit.h) * S, hit.ph * S - top)

const tmp = '/tmp/_croppage'
execSync(`pdftoppm -r ${DPI} -f ${hit.page} -l ${hit.page} -png "${pdfPath}" ${tmp}`, { stdio: 'pipe' })
const src = execSync(`ls ${tmp}-*.png | head -1`, { encoding: 'utf8' }).trim()
// sips 는 macOS 기본 — 별도 설치 없이 자른다
execSync(`sips -c ${Math.round(h)} ${Math.round(w)} --cropOffset ${Math.round(top)} ${Math.round(left)} "${src}" --out "${outPath}"`, { stdio: 'pipe' })
console.log(`${hit.page}쪽 · '${token}' 위치에서 잘라냄 → ${outPath}`)
