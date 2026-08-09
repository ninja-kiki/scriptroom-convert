// 대사 줄에 섞여 들어간 화자 큐를 떼어낸다.
//   PDF 추출에서 화자 이름이 대사와 같은 x좌표로 잡히면 큐(@NAME)가 아니라 대사(- NAME)가 된다.
//   그러면 리더기에서 '누가 말하는지'가 사라지고, 다음 대사가 앞 화자에게 붙는다.
//
//   패턴 A: `- 앞 대사 끝. NAME`      → `- 앞 대사 끝.` + `@NAME`
//   패턴 B: `- NAME`                  → `@NAME`
//
//   사용: node tools/fix-merged-cues.mjs <작품폴더|--all> [--write]
//
// 안전 원칙: 그 파일에 이미 @큐로 등장하는 이름만 화자로 인정한다(추측 금지).
//   formatted(영문)와 translated(한글)를 각각 자기 파일의 큐 목록으로 판정한다.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))
if (!ALL && !only) { console.error('사용: node tools/fix-merged-cues.mjs <작품폴더|--all> [--write]'); process.exit(1) }

const cueName = s => s.replace(/^@/, '').split('(')[0].trim()

function fixFile(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const names = new Set(lines.filter(l => l.startsWith('@')).map(l => cueName(l)).filter(n => n.length >= 2))
  if (!names.size) return { changed: 0 }

  // 이름은 길이가 긴 것부터 맞춰본다(‘JAMES’가 ‘JAMES SR.’를 가로채지 않도록)
  const sorted = [...names].sort((a, b) => b.length - a.length)
  const out = []
  let changed = 0
  for (const line of lines) {
    const s = line.trim()
    if (!s.startsWith('- ')) { out.push(line); continue }
    const body = s.slice(2).trim()

    // 패턴 B: 대사 전체가 화자 이름 하나
    if (names.has(body)) { out.push('@' + body); changed++; continue }

    // 패턴 A: 대사 끝에 화자 이름이 붙어 있음
    const hit = sorted.find(n => body.endsWith(' ' + n))
    if (hit) {
      const head = body.slice(0, body.length - hit.length - 1).trim()
      // 앞이 문장으로 끝나야 진짜 경계다(‘...를 만난 JAMES’ 같은 문장 중간 이름은 건드리지 않는다)
      if (head && /[.!?…"”'’)\]]$/.test(head)) {
        out.push('- ' + head, '', '@' + hit)
        changed++
        continue
      }
    }
    out.push(line)
  }
  if (WRITE && changed) {
    if (!existsSync(path + '.mcbak')) copyFileSync(path, path + '.mcbak')
    writeFileSync(path, out.join('\n'))
  }
  return { changed }
}

const works = ALL ? readdirSync(CONTENT) : [only]
let total = 0
for (const w of works) {
  let files
  try { files = readdirSync(join(CONTENT, w)) } catch { continue }
  const parts = []
  for (const re of [/_formatted\.txt$/, /_translated\.txt$/]) {
    const f = files.find(x => re.test(x))
    if (!f) continue
    const { changed } = fixFile(join(CONTENT, w, f))
    if (changed) parts.push(`${re.source.includes('formatted') ? '원문' : '번역'} ${changed}`)
    total += changed
  }
  if (parts.length) console.log(`  ${w.padEnd(34)} ${parts.join(' · ')}`)
}
console.log(`\n총 ${total}건${WRITE ? '' : '  (--write 없음 — 저장 안 함)'}`)
