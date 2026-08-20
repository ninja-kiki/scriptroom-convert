// PDF 하나에 붙일 연도를 알아낸다 — 새 작품 폴더는 항상 '<제목>-<연도>'로 끝나야 한다는
// scriptroom(라이브러리 앱) 쪽 규칙 때문이다. 폴더에 연도가 없는 경우와 있는 경우가 뒤섞이면
// 같은 작품이 다른 폴더로 인식된다(127hours vs 127-hours-2010, 피노키오, 리플리에서 실제로 겪음).
//
//   순서:
//   1) 파일명 자체에 이미 연도가 있으면 그걸 쓴다.
//   2) PDF 메타데이터(CreationDate)에서 연도를 뽑는다.
//   3) 앞 3쪽 본문에서 연도를 찾는다 — '©', 'Copyright', 'Draft', 'Revision' 근처에 있는 것을
//      우선한다(표지에 진짜 있을 확률이 높다). 못 찾으면 null.
//
//   null 이면 배치 스크립트가 폴더를 만들지 않고 사람 확인 목록에 올린다 — 틀린 연도를
//   붙이는 것보다, 안 붙이고 사람이 보는 게 낫다(틀린 연도는 또 다른 중복을 만든다).
//
//   사용: node tools/folder-year.mjs <PDF경로>   → 연도(문자열) 또는 빈 출력
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync } from 'fs'
import { basename } from 'path'

const path = process.argv[2]
if (!path) { console.error('사용: node tools/folder-year.mjs <PDF경로>'); process.exit(1) }

const fromFilename = basename(path).match(/(19|20)\d{2}(?!\d)/)
if (fromFilename) { console.log(fromFilename[0]); process.exit(0) }

const data = new Uint8Array(readFileSync(path))
const doc = await getDocument({ data, useSystemFonts: true }).promise

const meta = await doc.getMetadata().catch(() => null)
const cd = meta?.info?.CreationDate || meta?.info?.ModDate
if (cd) {
  const m = String(cd).match(/D:(\d{4})/) || String(cd).match(/(19|20)\d{2}/)
  if (m) { console.log(m[1] || m[0]); process.exit(0) }
}

let text = ''
for (let p = 1; p <= Math.min(3, doc.numPages); p++) {
  const tc = await (await doc.getPage(p)).getTextContent()
  text += tc.items.map(i => i.str).join(' ') + '\n'
}
const years = [...text.matchAll(/(19|20)\d{2}/g)].map(m => m[0])
if (!years.length) process.exit(0)  // 못 찾음 — 빈 출력
const near = (kw) => {
  const i = text.search(new RegExp(kw, 'i'))
  if (i < 0) return null
  const window = text.slice(Math.max(0, i - 30), i + 30)
  const m = window.match(/(19|20)\d{2}/)
  return m ? m[0] : null
}
console.log(near('©') || near('copyright') || near('draft') || near('revision') || years[0])
