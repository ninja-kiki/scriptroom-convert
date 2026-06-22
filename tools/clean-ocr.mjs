// OCR 스캔 각본의 특수기호 노이즈 청소 (토큰 0, 구조만).
//   node tools/clean-ocr.mjs "<formatted.txt 경로>"            # 미리보기(바뀌는 줄만 출력, 쓰기 안 함)
//   node tools/clean-ocr.mjs "<formatted.txt 경로>" --write    # .bak 백업 후 덮어쓰기
//
// 규칙(보수적): ① @큐 앞 잡기호 제거(인물명만 남김) ② 줄 앞 잡기호 제거
//              ③ 통째 쓰레기 줄(글자 없는 도형 OCR 잔해) 삭제
// 안 건드림: 괄호 지문 "(voice over)", 정상 대사/지문, 줄 중간 텍스트.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs'

const path = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!path) { console.error('사용: node tools/clean-ocr.mjs "<formatted.txt>" [--write]'); process.exit(1) }

const SCENE_WORDS = new Set(['DAY', 'NIGHT', 'MORNING', 'EVENING', 'AFTERNOON', 'CONT', 'CONTINUED', 'LATER', 'MOMENTS'])
const hasHangul = (s) => /[가-힣]/.test(s)
const hasWord = (s) => /[A-Za-z]{3,}/.test(s)        // 3글자 이상 연속 = 진짜 단어 신호
const hasVowel = (s) => /[AEIOU]/.test(s)
// 통째 쓰레기 판정: 한글X · 진짜단어X 인 줄 중에서, 잡기호/단일문자/띄어쓴-한글자/스캔코드만 삭제.
// "Go on." "No." "Me?" 같은 짧은 진짜 대사는 잡기호가 없으므로 보존된다.
function isGarbage(t) {
  if (hasHangul(t) || hasWord(t)) return false
  if (/[\^~|\\/£™•·*$&%<>{}\[\]=+]/.test(t)) return true        // 잡기호 포함
  if ((t.match(/[A-Za-z]/g) || []).length <= 1) return true     // 글자 0~1개 (i, r, N, ', D-10)
  if (/^([A-Za-z0-9]\s+){2,}[A-Za-z0-9.]*$/.test(t)) return true // 띄어쓴 한글자들 (g v X / C o n t)
  return false
}

// 줄 앞 잡기호 한 덩어리: (옵션 단일문자)+잡기호들+공백. "(" 는 뒤가 잡기호일 때만 잡힘(괄호 지문 보호).
const LEAD_JUNK = /^[\s]*(\(?[a-zA-Z]?[\^~|\\/*;:•·"]+\*?[\s]+)+/

// @큐: 뒤쪽의 대문자 인물명만 남김. 잡기호 사이에 낀 단일문자(C, r 등)도 제거.
function cleanCue(line) {
  const m = line.match(/([A-Z][A-Z][A-Z .'\-]*?|[A-Z]{2,})(\s*\((?:Cont\.?|CONT'?D)\.?\))?\s*$/)
  if (!m) return line
  const name = m[1].trim().replace(/\s+/g, ' ')
  const paren = m[2] ? ' ' + m[2].trim() : ''
  if (SCENE_WORDS.has(name.split(' ')[0])) return line   // "@- DAY" 류는 인물 아님 → 손대지 않음(플래그)
  if (!hasVowel(name)) return line                        // "SPSN" 류 자음덩어리 → 깨진 큐, 손대지 않음
  const cleaned = `@${name}${paren}`
  return cleaned === line.trim() ? line : cleaned
}

const lines = readFileSync(path, 'utf8').replace(/\r/g, '').split('\n')
const out = []
const changes = []   // {n, before, after|null(삭제)}

lines.forEach((line, i) => {
  const n = i + 1
  if (/^@/.test(line)) {
    const c = cleanCue(line)
    if (c !== line) changes.push({ n, before: line, after: c })
    out.push(c)
    return
  }
  const t = line.trim()
  if (t === '') { out.push(line); return }
  // ③ 통째 쓰레기 줄 삭제 (짧은 진짜 대사는 보존)
  if (isGarbage(t)) { changes.push({ n, before: line, after: null }); return }
  // ② 줄 앞 잡기호 제거
  const stripped = line.replace(LEAD_JUNK, '')
  if (stripped !== line) {
    if (stripped.trim() === '') { changes.push({ n, before: line, after: null }); return }
    changes.push({ n, before: line, after: stripped })
    out.push(stripped)
    return
  }
  out.push(line)
})

const removed = changes.filter(c => c.after === null).length
const edited = changes.filter(c => c.after !== null).length
console.log(`\n파일: ${path}`)
console.log(`바뀌는 줄: 수정 ${edited} · 삭제 ${removed} (전체 ${lines.length}줄)\n`)
for (const c of changes) {
  if (c.after === null) console.log(`  ${c.n}  ✗삭제  「${c.before}」`)
  else console.log(`  ${c.n}  「${c.before}」 → 「${c.after}」`)
}

if (WRITE) {
  if (!existsSync(path + '.ocrbak')) copyFileSync(path, path + '.ocrbak')
  writeFileSync(path, out.join('\n'))
  console.log(`\n✓ 덮어씀 (백업: ${path}.ocrbak)`)
} else {
  console.log(`\n(미리보기 — 적용하려면 --write)`)
}
