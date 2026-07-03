// 기존 작품 재변환(개선) 오케스트레이터 — PDF 재추출(템포)→청소→진단→재번역을 순차 실행.
//   node tools/reprocess.mjs <작품폴더> [--translate-only] [--instruction "수정 지시"]
// 전체(기본): PDF 좌표 재추출(템포 보존) → 노이즈 청소 → 진단 → 재번역
// --translate-only: 기존 formatted 유지, 진단+재번역만
import { readdirSync, existsSync, copyFileSync, readFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const TRANSLATE_ONLY = process.argv.includes('--translate-only')
const DIAGNOSE_ONLY = process.argv.includes('--diagnose-only')   // 진단까지만(게이트 1단계)
const ii = process.argv.indexOf('--instruction')
const INSTRUCTION = ii >= 0 ? (process.argv[ii + 1] || '') : ''
if (!work) { console.error('사용: node tools/reprocess.mjs <작품> [--translate-only] [--instruction "..."]'); process.exit(1) }

const dir = join(CONTENT, work)
if (!existsSync(dir)) { console.error(`작품 폴더 없음: ${dir}`); process.exit(1) }
const files = readdirSync(dir)
const pdf = files.find(f => /\.pdf$/i.test(f))
const fmt = files.find(f => /_formatted\.txt$/.test(f))
const run = (cmd) => { console.log('  $ ' + cmd); execSync(cmd, { cwd: ROOT, stdio: 'inherit' }) }
const q = (s) => JSON.stringify(s)

console.log(`[reprocess] ${work} · 모드=${TRANSLATE_ONLY ? '재번역만' : '전체'}${INSTRUCTION ? ' · 수정지시 있음' : ''}`)

if (!TRANSLATE_ONLY && pdf && fmt) {
  console.log('[1/3] PDF 좌표 재추출 (지문 템포 보존)')
  run(`node tools/pdf-reformat.mjs ${q(join(dir, pdf))} --write /tmp/reproc_fmt.txt 2>&1 | grep -vE "Warning|standardFont" || true`)
  if (!existsSync('/tmp/reproc_fmt.txt')) { console.error('  PDF 재추출 실패 — 기존 formatted로 진행') }
  else {
    const noisy = (readFileSync('/tmp/reproc_fmt.txt', 'utf8').match(/[\^~|\\]/g) || []).length > 20
    if (noisy) { console.log('[2/3] OCR 노이즈 청소'); run(`node tools/clean-ocr.mjs /tmp/reproc_fmt.txt --write`) }
    else console.log('[2/3] 노이즈 적음 — 청소 생략')
    // 안전장치: 재추출이 인물 큐(@) 구조를 크게 잃었으면(기존 formatted의 70% 미만) 재추출을 버리고 기존 formatted 사용.
    //   좌표 이상 PDF에서 큐가 지문에 병합돼 구조가 무너지는 회귀 방지. footer는 기존 formatted도 대개 없음.
    const cueCount = t => (t.match(/^@/gm) || []).length
    const reCues = cueCount(readFileSync('/tmp/reproc_fmt.txt', 'utf8'))
    const oldCues = cueCount(readFileSync(join(dir, fmt), 'utf8'))
    if (oldCues >= 20 && reCues < oldCues * 0.7) {
      console.log(`  ⚠ 재추출 큐 급감(${oldCues}→${reCues}) — 재추출 폐기, 기존 formatted 사용(구조 보존)`)
      unlinkSync('/tmp/reproc_fmt.txt')
    } else {
      console.log(`  formatted 재추출 OK (큐 ${oldCues}→${reCues}, /tmp — 원본 폴더 안 건드림)`)
    }
  }
} else if (!TRANSLATE_ONLY) {
  console.log('[1-2/3] PDF 없음 — 기존 formatted로 진행')
}
// 재추출본이 있으면(=구조 검증 통과) retranslate에 --src로 넘겨 content 대신 그걸 읽게 함
const SRC_ARG = existsSync('/tmp/reproc_fmt.txt') ? ' --src /tmp/reproc_fmt.txt' : ''

if (DIAGNOSE_ONLY) {
  console.log('[3/3] 진단(번역 대기)')
  run(`node tools/retranslate.mjs ${q(work)} --diagnose-only${SRC_ARG}`)
  console.log('[reprocess] 진단 완료 — 번역 시작 대기')
} else {
  // CLI 직접 실행(개인용): --out 없으면 retranslate가 content에 씀. 앱(server)은 reprocess를 --diagnose-only로만 부르고 번역은 retranslate를 --out으로 직접 spawn.
  console.log('[3/3] 진단 + 재번역')
  run(`node tools/retranslate.mjs ${q(work)} --write${SRC_ARG}${INSTRUCTION ? ` --instruction ${q(INSTRUCTION)}` : ''}`)
  console.log('[reprocess] ✓ 완료')
}
