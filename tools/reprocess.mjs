// 기존 작품 재변환(개선) 오케스트레이터 — PDF 재추출(템포)→청소→진단→재번역을 순차 실행.
//   node tools/reprocess.mjs <작품폴더> [--translate-only] [--instruction "수정 지시"]
// 전체(기본): PDF 좌표 재추출(템포 보존) → 노이즈 청소 → 진단 → 재번역
// --translate-only: 기존 formatted 유지, 진단+재번역만
import { readdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
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

// ★추출본 경로는 작품마다 다르게 잡는다.
//   예전엔 모든 작품이 /tmp/reproc_fmt.txt 하나를 같이 썼다. 그래서 이번 작품에서 추출을
//   건너뛰면 '앞 작품의 추출본'이 그대로 남아 --src 로 넘어갔다 — 엉뚱한 각본을 번역한다.
const TMP_FMT = `/tmp/reproc_fmt_${work.replace(/[^\w.-]/g, '_')}.txt`
if (existsSync(TMP_FMT)) unlinkSync(TMP_FMT)

// ★기존 formatted 유무와 무관하게, PDF가 있으면 추출한다.
//   예전엔 (pdf && fmt) 조건이라 formatted가 아직 없는 '신규 작품'은 PDF를 통째로 건너뛰었다.
if (!TRANSLATE_ONLY && pdf) {
  console.log(`[1/3] PDF 좌표 ${fmt ? '재' : ''}추출 (지문 템포 보존)`)
  run(`node tools/pdf-reformat.mjs ${q(join(dir, pdf))} --write ${TMP_FMT} 2>&1 | grep -vE "Warning|standardFont" || true`)
  if (!existsSync(TMP_FMT)) { console.error('  PDF 추출 실패') }
  else {
    const noisy = (readFileSync(TMP_FMT, 'utf8').match(/[\^~|\\]/g) || []).length > 20
    if (noisy) { console.log('[2/3] OCR 노이즈 청소'); run(`node tools/clean-ocr.mjs ${TMP_FMT} --write`) }
    else console.log('[2/3] 노이즈 적음 — 청소 생략')
    const cueCount = t => (t.match(/^@/gm) || []).length
    const reCues = cueCount(readFileSync(TMP_FMT, 'utf8'))
    if (!fmt) {
      // 신규 작품 — 비교 대상이 없으니 추출 자체가 성립했는지만 본다
      const sc = (readFileSync(TMP_FMT, 'utf8').match(/^# /gm) || []).length
      if (sc < 5 || reCues < 10) { console.error(`  ⚠ 추출 결과가 빈약하다(씬 ${sc} · 큐 ${reCues}) — 중단`); process.exit(4) }
      console.log(`  신규 추출 OK (씬 ${sc} · 큐 ${reCues})`)
      // 신규 작품은 추출본을 그대로 작품 폴더의 formatted 로 삼는다
      const base = pdf.replace(/\.pdf$/i, '')
      writeFileSync(join(dir, `${base}_formatted.txt`), readFileSync(TMP_FMT, 'utf8'))
      console.log(`  → ${base}_formatted.txt 생성`)
    } else {
      // 안전장치: 재추출이 인물 큐(@) 구조를 크게 잃었으면 재추출을 버리고 기존 formatted 사용.
      const oldCues = cueCount(readFileSync(join(dir, fmt), 'utf8'))
      if (oldCues >= 20 && reCues < oldCues * 0.7) {
        console.log(`  ⚠ 재추출 큐 급감(${oldCues}→${reCues}) — 재추출 폐기, 기존 formatted 사용(구조 보존)`)
        unlinkSync(TMP_FMT)
      } else {
        console.log(`  formatted 재추출 OK (큐 ${oldCues}→${reCues}, /tmp — 원본 폴더 안 건드림)`)
      }
    }
  }
} else if (!TRANSLATE_ONLY) {
  if (!fmt) { console.error('  PDF도 formatted도 없다 — 중단'); process.exit(4) }
  console.log('[1-2/3] PDF 없음 — 기존 formatted로 진행')
}
// 재추출본이 있으면(=구조 검증 통과) retranslate에 --src로 넘겨 content 대신 그걸 읽게 함
const SRC_ARG = existsSync(TMP_FMT) ? ` --src ${TMP_FMT}` : ''

if (DIAGNOSE_ONLY) {
  console.log('[3/3] 진단(번역 대기)')
  run(`node tools/retranslate.mjs ${q(work)} --diagnose-only${SRC_ARG}`)
  console.log('[reprocess] 진단 완료 — 번역 시작 대기')
} else {
  // CLI 직접 실행(개인용): --out 없으면 retranslate가 content에 씀. 앱(server)은 reprocess를 --diagnose-only로만 부르고 번역은 retranslate를 --out으로 직접 spawn.
  // ★--resume 항상 추가: 씬 수만 안 바뀌면(같은 PDF 재추출은 결정적) 이미 번역된 씬은 재사용하고 남은 것만 이어서 번역.
  //   서버 500으로 중간에 죽어 재시도할 때 처음부터 다시 도는 걸 막는다(안 그러면 큰 작품은 재시도마다 진행률이 0으로 리셋됨).
  console.log('[3/3] 진단 + 재번역')
  run(`node tools/retranslate.mjs ${q(work)} --write --resume${SRC_ARG}${INSTRUCTION ? ` --instruction ${q(INSTRUCTION)}` : ''}`)
  console.log('[reprocess] ✓ 완료')
}
