// 스캔 PDF를 다시 OCR해서 '줄 목록'을 만든다 — 내장 텍스트 레이어가 깨진 각본용.
//
//   왜 필요한가: 오래된 각본 PDF는 스캔 후 OCR한 텍스트 레이어를 갖고 있는데, 그 품질이
//   나쁘면 낱말 안쪽이 깨진다 — 네트워크(1976): 'HOWARD BEALE' → 'HOWAP.O BE:t.LE',
//   'Monday' → 'Y..onday', 'CAMERA' → 'CJ\MERA'. 줄을 통째로 지우는 청소로는 손댈 수 없다
//   (clean-ocr 로 잡티 909→868, 정상 낱말 70.1%→70.6% — 사실상 효과 없음).
//   원본 이미지를 다시 읽는 수밖에 없다.
//
//   왜 tesseract TSV 인가: 그냥 텍스트로 뽑으면 좌표가 사라져 지문/대사/인물 열을 못 가른다.
//   TSV 는 낱말마다 좌표와 신뢰도를 준다 — 좌표로 열을 살리고, 신뢰도로 스캔 얼룩을 버린다.
//   얼룩은 '.' '-' ':' 같은 한 글자로 신뢰도 0~35에 몰리고, 진짜 낱말은 70~95에 있다.
//
//   출력: page<TAB>x<TAB>y<TAB>text  (좌표는 PDF 포인트 기준으로 환산)
//   사용: node tools/ocr-extract.mjs <PDF> --out <lines.tsv> [--dpi 300] [--conf 40]
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const args = process.argv.slice(2)
const pdf = args.find(a => !a.startsWith('--'))
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : null
const dpi = Number(args[args.indexOf('--dpi') + 1]) || 300
const MINCONF = Number(args[args.indexOf('--conf') + 1]) || 40
if (!pdf || !out) { console.error('사용: node tools/ocr-extract.mjs <PDF> --out <lines.tsv> [--dpi 300] [--conf 40]'); process.exit(1) }

const dir = mkdtempSync(join(tmpdir(), 'ocrx-'))
try {
  console.error(`이미지 변환 중 (${dpi}dpi)...`)
  execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdf, join(dir, 'pg')], { stdio: 'ignore' })
  const pages = readdirSync(dir).filter(f => f.endsWith('.png')).sort()
  console.error(`${pages.length}쪽 OCR 중...`)
  const scale = 72 / dpi                    // 이미지 픽셀 → PDF 포인트
  const rows = []
  pages.forEach((f, idx) => {
    const base = join(dir, f.replace(/\.png$/, ''))
    execFileSync('tesseract', [join(dir, f), base, '--psm', '6', 'tsv'], { stdio: 'ignore' })
    const tsv = readFileSync(base + '.tsv', 'utf8').split('\n').slice(1)
    // (block, par, line) 이 같으면 한 줄이다. 신뢰도 낮은 낱말은 버린다(스캔 얼룩).
    const byLine = new Map()
    for (const r of tsv) {
      const c = r.split('\t')
      if (c.length < 12) continue
      const conf = parseFloat(c[10]); const text = c[11]
      if (!text || !text.trim() || !(conf >= MINCONF)) continue
      const key = `${c[2]}|${c[3]}|${c[4]}`
      const left = +c[6], top = +c[7]
      const e = byLine.get(key) || { x: Infinity, y: 0, words: [] }
      e.x = Math.min(e.x, left); e.y = top; e.words.push([left, text])
      byLine.set(key, e)
    }
    for (const e of byLine.values()) {
      const text = e.words.sort((a, b) => a[0] - b[0]).map(w => w[1]).join(' ').replace(/\s+/g, ' ').trim()
      if (text) rows.push([idx + 1, Math.round(e.x * scale), Math.round(-e.y * scale), text])
    }
    if ((idx + 1) % 20 === 0) console.error(`  ${idx + 1}/${pages.length}쪽`)
  })
  // 페이지 순 → 페이지 안에서는 위에서 아래로(y 내림차순: 위쪽이 큰 값)
  rows.sort((a, b) => a[0] - b[0] || b[2] - a[2])
  writeFileSync(out, rows.map(r => r.join('\t')).join('\n') + '\n')
  console.error(`→ ${out} (${rows.length}줄)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
