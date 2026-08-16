// 밴드 오판 진단 — 각 작품 PDF에서 '실제 대사 클러스터'와 '계산된 대사 경계'를 비교한다.
//   현재 코드는 인물 큐 밴드만 데이터로 찾고, 대사 경계는 (지문+인물)/2 라는 기하학적 중점으로 정한다.
//   대사가 그 중점보다 조금이라도 왼쪽에 있으면 통째로 지문이 된다.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'

function isRealCue(s) {
  let c = s.replace(/\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT|MORE)\.?\)\s*$/i, '').trim()
  if (!c || c.length > 28 || /[.,!?;]$/.test(c) || c.split(/\s+/).length > 4) return false
  if (/^(ON|IN|AT|TO|INSERT|CU|POV|ANGLE|CLOSE|WIDE|BACK|REVERSE|MONTAGE|INTERCUT|SERIES|MUSIC|CHYRON|SUPER|CREDIT|ACROSS|THROUGH|FULL|MED|MEDIUM|TWO|THREE|GROUP|TIGHT|LOW|HIGH|AERIAL|TRACKING|PAN|ZOOM|RESUME|FAVORING)\b/i.test(c)) return false
  if (/^(ACT|END OF ACT|END ACT|TEASER|END TEASER|COLD OPEN|END OF TEASER|TAG|END OF SHOW|MAIN TITLES?|END CREDITS)\b/i.test(c)) return false
  const L = c.replace(/[^A-Za-z]/g, ''), U = c.replace(/[^A-Z]/g, '')
  return L.length >= 2 && U.length / L.length >= 0.9
}

async function lines(path) {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise
  const out = []
  const maxP = Math.min(pdf.numPages, 60)
  for (let p = 1; p <= maxP; p++) {
    const items = (await pdf.getPage(p)).getTextContent ? (await (await pdf.getPage(p)).getTextContent()).items : []
    let lastY = null, x = null, txt = ''
    for (const it of items) {
      const ix = it.transform[4], iy = it.transform[5]
      if (lastY !== null && Math.abs(iy - lastY) > 3) { if (txt.trim()) out.push({ x, text: txt.trim() }); txt = ''; x = null }
      if (x === null) x = ix
      txt += it.str; lastY = iy
    }
    if (txt.trim()) out.push({ x, text: txt.trim() })
  }
  return out
}

const works = process.argv.slice(2)
const rows = []
for (const w of works) {
  const dir = join(CONTENT, w)
  if (!existsSync(dir)) continue
  const pdf = readdirSync(dir).find(f => /\.pdf$/i.test(f))
  if (!pdf) continue
  let L
  try { L = await lines(join(dir, pdf)) } catch { continue }
  if (!L.length) continue

  const bx = x => Math.round(x / 5) * 5
  const freq = {}, cueFreq = {}
  for (const l of L) {
    const k = bx(l.x); freq[k] = (freq[k] || 0) + 1
    if (isRealCue(l.text)) cueFreq[k] = (cueFreq[k] || 0) + 1
  }
  const xsByFreq = Object.entries(freq).map(([x, n]) => [+x, n]).sort((a, b) => b[1] - a[1])
  const cueSorted = Object.entries(cueFreq).map(([x, n]) => [+x, n]).sort((a, b) => b[1] - a[1])
  if (!(cueSorted.length && cueSorted[0][1] >= 5)) { rows.push({ w, note: '큐 클러스터 없음(폴백 경로)' }); continue }

  const xChar = cueSorted[0][0]
  const character = xChar - 20
  const leftPeaks = xsByFreq.filter(([x]) => x < character - 30)
  const xAction = leftPeaks.length ? Math.min(...leftPeaks.slice(0, 3).map(e => e[0])) : xChar - 220
  const dlgThreshold = Math.round((xAction + character) / 2)

  // 실제 대사 클러스터 = 지문과 인물 사이에서 가장 큰 봉우리
  const mid = Object.entries(freq).map(([x, n]) => [+x, n])
    .filter(([x]) => x > xAction + 10 && x < character)
    .sort((a, b) => b[1] - a[1])
  if (!mid.length) { rows.push({ w, note: '중간 봉우리 없음' }); continue }
  const [dlgPeak, dlgCount] = mid[0]

  // 위험 구간: 실제 대사 클러스터에 속하는데 경계보다 왼쪽이라 지문이 되는 줄
  const danger = L.filter(l => l.x >= dlgPeak - 6 && l.x < dlgThreshold).length
  rows.push({ w, xAction, dlgThreshold, dlgPeak, dlgCount, danger, gap: dlgPeak - dlgThreshold })
}

rows.sort((a, b) => (b.danger || 0) - (a.danger || 0))
console.log('작품'.padEnd(38), '지문x', '경계', '실제대사x', '갭', '위험줄')
for (const r of rows) {
  if (r.note) { console.log(`${r.w.padEnd(38)} ${r.note}`); continue }
  const mark = r.danger > 0 ? ' ← 오판' : ''
  console.log(`${r.w.padEnd(38)} ${String(r.xAction).padStart(5)} ${String(r.dlgThreshold).padStart(5)} ${String(r.dlgPeak).padStart(8)} ${String(r.gap).padStart(4)} ${String(r.danger).padStart(6)}${mark}`)
}
const bad = rows.filter(r => r.danger > 0)
console.log(`\n오판 작품 ${bad.length} / ${rows.filter(r => !r.note).length}편 · 위험 줄 합계 ${bad.reduce((s, r) => s + r.danger, 0)}`)
