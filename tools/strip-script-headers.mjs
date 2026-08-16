// 본문에 섞여 들어간 '대본 러닝헤더'를 지운다.
//   PDF 페이지마다 찍힌 머리글(The Martian Shooting Script 5. / SALMON #2 XX/XX/07 3.)이
//   추출 때 대사·지문 한복판에 들어가고, 번역기가 그걸 한국어로 옮기기까지 했다
//   ('마션 촬영 대본 13.'). strip-running-header.mjs 는 '3회 이상 반복되는 영어 줄'만 보기 때문에
//   문장 중간에 박히거나 한국어로 번역된 머리글은 잡지 못했다.
//
//   사용: node tools/strip-script-headers.mjs <작품폴더|--all> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))
if (!ALL && !only) { console.error('사용: node tools/strip-script-headers.mjs <작품폴더|--all> [--write]'); process.exit(1) }

const PATS = [
  /(?:The\s+)?[A-Z][A-Za-z' ]{2,30}\s+Shooting\s+Script\s+\d+\.?/g,   // The Martian Shooting Script 5.
  /[가-힣]{2,12}\s*(?:촬영\s*)?(?:대본|각본|슈팅\s*스크립트)\s*\d+\.?/g,  // 마션 촬영 대본 13.
  /\b[A-Z]{3,10}\s*#\d+\s+[X\d]{2}\/[X\d]{2}\/\d{2}\s*\d*[A-Z]?\.?/g, // SALMON #2 XX/XX/07 6A.
  // 제목 + 개정색 + 날짜 머리글: 'MEMENTO Blue Revisions – 8/27/99', 'MEMENTO - Green Revisions 10-4-99'
  //   뒤에 'NN CONTINUED:' 가 붙어 나오는 일이 잦아 그것까지 함께 흡수한다.
  /[A-Z][A-Za-z' ]{2,24}\s*[-–—]?\s*(?:White|Blue|Pink|Yellow|Green|Goldenrod|Buff|Salmon|Cherry|Tan)\s*Revisions?\s*[-–—]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s*\d{1,4}\s*CONTINUED:?(?:\s*\(\d+\))?)?/gi,
  // 그 머리글이 한국어로 번역돼 들어온 형태: '메멘토 블루 리비전 – 8/27/9'
  /[가-힣]{2,12}\s*(?:화이트|블루|핑크|옐로우|그린|골든로드|버프|살몬|체리|탄)\s*(?:리비전|개정)\s*[-–—]?\s*\d{1,2}[/-]\d{1,4}[/-]?\d{0,4}/g,
  // 날짜 자리를 채우지 않은 틀: 'Blue Rev. (mm/dd/yy) 66.'
  /(?:White|Blue|Pink|Yellow|Green|Goldenrod|Buff|Salmon|Cherry|Tan)\s*Rev\.?\s*\((?:mm\/dd\/yy|\d{1,2}\/\d{1,2}\/\d{2,4})\)\s*\d{0,4}[A-Z]?\.?/gi,
  // 제목 붙은 대본 확정판 머리글: '"BLUE MOON" CONFORMED SCRIPT 1.9.2025 Pg. 11'
  /"[A-Z][A-Z0-9 '.-]{1,40}"\s*CONFORMED\s*SCRIPT\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s*Pg\.?\s*\d+\.?/gi,
  // 개정색 + SHOOTING SCRIPT + 날짜 + 페이지: 'PINK SHOOTING SCRIPT (JUNE 17, 2024) 60DA.'
  /(?:White|Blue|Pink|Yellow|Green|Goldenrod|Buff|Salmon|Cherry|Tan)\s*(?:SHOOTING\s*)?SCRIPT\s*\([A-Za-z]+\s*\d{1,2},?\s*\d{4}\)\s*[\d\w.-]*/gi,
  // 삭제된 씬 표시: 'OMITTED85-89A 85-89A', 'OMITTED (NOW SC. 110A) 108', 'OMITTEDMOVED TO 65A'
  //   ★뒤에 붙는 건 '씬 번호'만 먹어야 한다. \w 로 열어두면 'OMITTED 라고 말했다'처럼
  //   본문 단어까지 삼킨다(실제로 그렇게 만들었다가 잡았다). 숫자·씬번호 꼴로만 한정한다.
  /OMITTED(?:\s*\(NOW[^)]*\))?(?:\s*MOVED\s+TO)?(?:\s*\d+[A-Z]?(?:\s*[-–]\s*\d+[A-Z]?)?)*(?:\s+IN\s+[A-Z]+)?(?:\s*\d+[A-Z]?)*\.?/g,
]

function strip(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  let removed = 0, cleaned = 0
  const out = []
  for (const line of lines) {
    let s = line
    let hit = false
    for (const p of PATS) { p.lastIndex = 0; if (p.test(s)) { hit = true } }
    if (!hit) { out.push(line); continue }
    for (const p of PATS) s = s.replace(p, ' ')
    s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?…])/g, '$1').trimEnd()
    // 머리글만 있던 줄이면 통째로 버린다('- ' 나 빈 껍데기만 남는 경우 포함)
    if (!s.replace(/^[-\s]+/, '').trim()) { removed++; continue }
    cleaned++
    out.push(s)
  }
  // 줄을 지우면서 생긴 연속 빈 줄 정리
  const tidy = []
  for (const l of out) {
    if (!l.trim() && tidy.length && !tidy[tidy.length - 1].trim()) continue
    tidy.push(l)
  }
  if (WRITE && (removed || cleaned)) {
    if (!existsSync(path + '.shbak')) copyFileSync(path, path + '.shbak')
    writeFileSync(path, tidy.join('\n'))
  }
  return { removed, cleaned }
}

const works = ALL ? readdirSync(CONTENT) : [only]
let R = 0, C = 0
for (const w of works) {
  let files
  try { files = readdirSync(join(CONTENT, w)) } catch { continue }
  for (const re of [/_formatted\.txt$/, /_translated\.txt$/]) {
    const f = files.find(x => re.test(x))
    if (!f) continue
    const { removed, cleaned } = strip(join(CONTENT, w, f))
    if (removed || cleaned) {
      console.log(`  ${w.padEnd(30)} ${re.source.includes('formatted') ? '원문' : '번역'} · 줄삭제 ${removed} · 문장정리 ${cleaned}`)
      R += removed; C += cleaned
    }
  }
}
console.log(`\n총 줄삭제 ${R} · 문장정리 ${C}${WRITE ? '' : '  (--write 없음 — 저장 안 함)'}`)
