// 실측 진단 — 고친 추출기로 다시 뽑아, 기존 formatted 와 '블록 종류'가 얼마나 달라지는지 센다.
//   기존에 지문(마커 없음)이던 문장이 새로 대사(- ) 안에 들어가면 = 원래 대사인데 지문으로 잘못 분류돼 있던 것.
//   ★수정으로 블록이 병합되는 경우가 많아 완전일치로는 놓친다 → 부분일치(포함 여부)로 센다.
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const norm = s => s.replace(/^[-@#(]\s*/, '').replace(/[\s"'’‘“”.,!?—–\-()]/g, '').toLowerCase()

const rows = []
for (const w of process.argv.slice(2)) {
  const dir = join(CONTENT, w)
  if (!existsSync(dir)) continue
  const pdf = readdirSync(dir).find(f => /\.pdf$/i.test(f))
  const oldF = readdirSync(dir).find(f => /_formatted\.txt$/.test(f))
  if (!pdf || !oldF) continue

  const tmp = `/tmp/_diag_${w.replace(/[^\w.-]/g, '_')}.txt`
  try {
    execSync(`node tools/pdf-reformat.mjs ${JSON.stringify(join(dir, pdf))} --write ${tmp} 2>/dev/null`,
      { cwd: '/Users/hojun/Projects/scriptroom-convert-local', stdio: 'pipe' })
  } catch { continue }
  if (!existsSync(tmp)) continue

  // 새 추출본에서 대사로 분류된 텍스트를 한 덩어리로 (부분일치 검색용)
  const newDialogue = readFileSync(tmp, 'utf8').split('\n\n')
    .map(b => b.trim()).filter(b => b.startsWith('- ')).map(norm).join('')

  // 기존에 지문이던 문장들
  const oldBlocks = readFileSync(join(dir, oldF), 'utf8').split('\n\n')
  let flipped = 0, checked = 0
  const samples = []
  for (const b of oldBlocks) {
    const t = b.trim()
    if (!t || /^[-@#(]/.test(t)) continue
    const k = norm(t)
    if (k.length < 15) continue
    checked++
    // 앞 40자만으로 포함 검사(병합·구두점 변형 흡수)
    if (newDialogue.includes(k.slice(0, 40))) {
      flipped++
      if (samples.length < 2) samples.push(t.replace(/\n/g, ' ').slice(0, 65))
    }
  }
  rows.push({ w, flipped, checked, samples })
}

rows.sort((a, b) => b.flipped - a.flipped)
let total = 0, totalChecked = 0
for (const r of rows) {
  total += r.flipped; totalChecked += r.checked
  if (r.flipped) console.log(`  ${r.w.padEnd(38)} ${String(r.flipped).padStart(5)} / 지문블록 ${r.checked}`)
}
console.log(`\n지문→대사로 바로잡힌 블록 ${total} · 영향 작품 ${rows.filter(r => r.flipped).length}/${rows.length}편`)
if (rows.length && rows[0].samples.length) {
  console.log(`\n예시 [${rows[0].w}]`)
  for (const s of rows[0].samples) console.log('   ' + s)
}
