// PDF 원본과 추출 결과를 '낱말 단위'로 대조한다 — 각본에 있는데 결과에 없는 내용을 찾는다.
//
//   왜 낱말 단위인가: 줄 단위로 맞춰보면 추출기가 줄을 합치거나(soft-wrap) 씬번호를 떼거나
//   마커를 붙이기만 해도 '없음'으로 잡힌다. 실제로 그렇게 세면 멀쩡한 작품이 80%로 나왔고,
//   원인을 하나 걷어낼 때마다 새 꼬리가 나왔다(번호 붙음·머리글 변형·이중 대사…).
//   낱말은 그 모든 변형에 흔들리지 않는다 — 내용이 살아있으면 낱말도 살아있다.
//
//   세는 방법: 알파벳/한글 4글자 이상 낱말만, 개수(중복 포함)로 센다.
//   PDF에 5번 나온 낱말이 결과에 3번뿐이면 2개가 사라진 것이다 — 대사 한 덩어리가
//   통째로 빠지는 사고를 이 방식이 잡아낸다.
//
//   사용: node tools/check-pdf-words.mjs <작품폴더|--all> [--list]
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const LIST = args.includes('--list')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))

const WORD = /[\p{L}][\p{L}'’-]{3,}/gu
const words = s => (s.toLowerCase().match(WORD) || []).map(w => w.replace(/[^\p{L}]/gu, '')).filter(w => w.length >= 4)

// 제작 정보 낱말 — 타이틀 페이지와 러닝 헤더에만 나오고 본문에는 안 나온다. 손실로 세지 않는다.
const PROD = new Set(['revision','revisions','revised','draft','shooting','script','screenplay','written','story','teleplay','copyright','rights','reserved','property','confidential','continued','contd','omitted','pages','page','white','blue','pink','yellow','green','goldenrod','buff','salmon','cherry','final','based','directed','episode','production','productions','pictures','entertainment','studios','films'])

async function pdfText(path) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise
  let out = ''
  for (let p = 1; p <= doc.numPages; p++)
    for (const it of (await (await doc.getPage(p)).getTextContent()).items)
      if (it.str) out += it.str + ' '
  return out
}

async function check(work) {
  const dir = join(CONTENT, work)
  let files; try { files = readdirSync(dir) } catch { return null }
  const pdf = files.find(f => /\.pdf$/i.test(f))
  const fmt = files.find(f => /_formatted\.txt$/.test(f))
  if (!pdf || !fmt) return null

  const src = words(await pdfText(join(dir, pdf)))
  const got = words(readFileSync(join(dir, fmt), 'utf8'))
  const have = new Map()
  for (const w of got) have.set(w, (have.get(w) || 0) + 1)

  const lost = new Map()
  let total = 0, missing = 0
  for (const w of src) {
    if (PROD.has(w)) continue
    total++
    const n = have.get(w) || 0
    if (n > 0) have.set(w, n - 1)
    else { missing++; lost.set(w, (lost.get(w) || 0) + 1) }
  }
  return { work, total, missing, lost }
}

const list = ALL
  ? readdirSync(CONTENT).filter(n => { if (['scripts','scripts-ocr','posters-bauhaus'].includes(n) || n.startsWith('.')) return false; try { return statSync(join(CONTENT, n)).isDirectory() } catch { return false } })
  : [only]
if (!only && !ALL) { console.error('사용: node tools/check-pdf-words.mjs <작품폴더|--all> [--list]'); process.exit(1) }

for (const w of list) {
  let r; try { r = await check(w) } catch (e) { console.log(`${w}\tERR\t0\t0`); continue }
  if (!r) continue
  const pct = r.total ? 100 * (r.total - r.missing) / r.total : 100
  console.log(`${r.work}\t${r.total}\t${r.missing}\t${pct.toFixed(2)}`)
  if (LIST) {
    const top = [...r.lost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    for (const [w2, n] of top) console.log(`    ${String(n).padStart(4)}회  ${w2}`)
  }
}
