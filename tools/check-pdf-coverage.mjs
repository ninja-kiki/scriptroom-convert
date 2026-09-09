// PDF 원본과 추출 결과(_formatted.txt)를 직접 대조해, 각본에 있는데 결과에 없는 내용을 찾는다.
//
//   왜 필요한가: 지금까지 검사는 formatted↔translated 만 비교했다. 둘 다 같은 추출본에서
//   나오므로, 추출 단계에서 이미 날아간 내용은 어느 검사에도 안 잡힌다.
//   실제로 라이트하우스의 등장인물 소개(PLAYERS)가 그렇게 통째로 사라졌는데
//   모든 지표가 '정상'이었다.
//
//   방법: PDF의 모든 텍스트 줄을 뽑아, 그 내용이 formatted 안에 있는지 본다.
//   비교는 공백·구두점·대소문자를 지운 '알맹이'로 한다(추출기가 줄을 합치거나 마커를 붙이므로).
//
//   사용: node tools/check-pdf-coverage.mjs <작품폴더> [--list] [--all]
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const LIST = args.includes('--list')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))

const norm = s => s.replace(/[\s]/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

// 정당하게 버려지는 것들 — 쪽번호·머리글·개정표시. 이건 '손실'이 아니다.
const FURNITURE = [
  /^\(?(continued|cont'?d|more)\)?:?$/i,
  /^[\d.]+$/,                                  // 12.  ·  105
  /^[a-z]?\d{1,4}[a-z]?\.?$/i,                 // 7A · A105.
  /^[ivxlcdm]{1,7}\.$/,                        // 쪽번호 로마숫자
  /^[—–-]\s*\d{1,4}\s*[—–-]$/,
  /^\*+$/,
]
const isFurniture = t => FURNITURE.some(re => re.test(t.trim()))

// ★PDF를 추출기(pdf-reformat.mjs)와 똑같은 방식으로 읽는다 — 아이템이 나온 순서 그대로,
//   y가 바뀌면 새 줄. 예전엔 여기서 x좌표로 정렬했는데, 그러면 읽는 순서가 x 순서와 반대인
//   PDF에서 글자가 뒤집힌다('September 2, 2002' → '20022,September'). 그 바람에 멀쩡한 작품이
//   커버리지 12%로 나왔다(빅·사랑도 통역이 되나요·브로크백). 읽는 방식이 다르면 그 차이가
//   전부 '손실'로 잡히므로, 검사기는 추출기와 같은 눈으로 봐야 한다.
async function pdfLines(path) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise
  const out = []
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items.filter(i => 'str' in i)
    let lastY = null, text = ''
    const push = () => { const t = text.replace(/\s+/g, ' ').trim(); if (t) out.push({ page: p, text: t }) }
    for (const it of items) {
      const iy = it.transform[5]
      if (lastY !== null && Math.abs(iy - lastY) > 3) { push(); text = '' }
      text += it.str; lastY = iy
    }
    push()
  }
  return out
}

async function check(work) {
  const dir = join(CONTENT, work)
  let files; try { files = readdirSync(dir) } catch { return null }
  const pdf = files.find(f => /\.pdf$/i.test(f))
  const fmt = files.find(f => /_formatted\.txt$/.test(f))
  if (!pdf || !fmt) return null
  const lines = await pdfLines(join(dir, pdf))
  const hay = norm(readFileSync(join(dir, fmt), 'utf8'))
  // ★없는 줄을 전부 '손실'로 세면 안 된다. 일부러 버리는 것이 섞여 있어서, 그대로 세면
  //   멀쩡한 작품이 80%로 나온다(아이언맨·메멘토는 없는 줄의 대부분이 타이틀 크레딧이었다).
  //   종류를 갈라서, 마지막 '본문' 칸만 실제로 조치가 필요한 손실이다.
  //     타이틀  = 첫 씬 헤딩 앞의 크레딧·판권 (버리기로 한 것)
  //     머리글  = 여러 쪽에 반복되는 러닝 헤더·쪽번호 (버리기로 한 것)
  //     번호    = 씬번호만 떼고 보면 내용이 그대로 있는 줄 (손실 아님)
  //     본문    = 위 어디에도 안 드는 진짜 없어진 내용
  const SCENE_START = /^(\d{1,4}[A-Z]?\.?\s+)?(INT|EXT|I\/E|INT\.\/EXT)[.\s]/i
  let firstScene = lines.findIndex(l => SCENE_START.test(l.text))
  if (firstScene < 0) firstScene = 0
  const seen = new Map()
  for (const l of lines) { const k = norm(l.text); if (k.length >= 6) seen.set(k, (seen.get(k) || 0) + 1) }
  const stripNums = t => t.replace(/^\s*\d{1,4}[A-Z]?\.?\s+/, '').replace(/\s*\d{1,4}[A-Z]?\.?\s*\*?\s*$/, '').trim()

  const missing = []
  const cat = { 타이틀: 0, 머리글: 0, 번호: 0, 본문: 0 }
  let checked = 0
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li]
    if (isFurniture(l.text)) continue
    const n = norm(l.text)
    if (n.length < 6) continue          // 너무 짧으면 우연히 맞을 수 있어 판정 보류
    checked++
    if (hay.includes(n)) continue
    // ★동시 대사(두 인물이 같은 y에 좌우로 찍힌 판형)는 원본 줄 하나가 두 사람 말의 조각이다
    //   ('I mean, I'm a wickie, you' + ''Tis Gospel!'). 추출기는 이걸 올바로 갈라 놓는데,
    //   통째로 찾으면 '없음'으로 나온다 — 실제로는 멀쩡히 들어있다.
    //   그래서 한 번 갈라 양쪽이 다 있으면 온전한 것으로 친다.
    let split = false
    for (let k = 6; k <= n.length - 6; k++) {
      if (hay.includes(n.slice(0, k)) && hay.includes(n.slice(k))) { split = true; break }
    }
    if (split) continue
    // 분류
    if (li < firstScene) { cat.타이틀++; continue }
    if ((seen.get(n) || 0) >= 3) { cat.머리글++; continue }
    const sn = norm(stripNums(l.text))
    if (sn.length >= 6 && hay.includes(sn)) { cat.번호++; continue }
    cat.본문++
    missing.push(l)
  }
  return { work, checked, missing, cat }
}

const works = ALL
  ? readdirSync(CONTENT).filter(n => { if (['scripts','scripts-ocr','posters-bauhaus'].includes(n)||n.startsWith('.')) return false; try { return statSync(join(CONTENT,n)).isDirectory() } catch { return false } })
  : [only]
if (!only && !ALL) { console.error('사용: node tools/check-pdf-coverage.mjs <작품폴더|--all> [--list]'); process.exit(1) }

for (const w of works) {
  let r; try { r = await check(w) } catch (e) { console.log(`${w}\tERR\t${e.message.slice(0,40)}`); continue }
  if (!r) continue
  const pct = r.checked ? (100 * (r.checked - r.missing.length) / r.checked) : 100
  console.log(`${r.work}\t${r.checked}\t${r.missing.length}\t${pct.toFixed(2)}\t${r.cat.타이틀}\t${r.cat.머리글}\t${r.cat.번호}`)
  if (LIST) for (const m of r.missing.slice(0, 40)) console.log(`    p${m.page}  ${m.text.slice(0, 110)}`)
}
