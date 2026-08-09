// 씬 헤딩 앞머리의 INT./EXT. 를 내부./외부. 로 옮긴다.
//   fix-headings.mjs 는 '한글이 하나도 없는' 헤딩만 다시 번역하기 때문에
//   `# INT. 아론의 집. 밤.` 처럼 앞머리만 영어로 남은 헤딩(라이브러리 2,400여 건)을 놓쳤다.
//   번역 지침은 INT.→내부. / EXT.→외부. / INT./EXT.→내부/외부. 이므로 기계적으로 맞춘다.
//
//   사용: node tools/fix-heading-prefix.mjs <작품폴더|--all> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))
if (!ALL && !only) { console.error('사용: node tools/fix-heading-prefix.mjs <작품폴더|--all> [--write]'); process.exit(1) }

// 긴 형태부터 맞춰야 'INT'가 'INT./EXT.'나 'INTERCUT'을 가로채지 않는다.
//   구분자가 각본마다 제각각이다: 'INT.' 'INT:' 'INT—' 'INT.거실'(붙여쓰기) 등.
//   그래서 뒤에 오는 문자를 공백으로 한정하지 않고, 마침표·콜론·대시·바로 이어지는 한글까지 허용한다.
const SEP = String.raw`(?=$|[\s.:;,–—-]|[가-힣])`
const RULES = [
  [/^#(\s+)INTERCUT/i, '#$1인터컷'],
  [new RegExp(String.raw`^#(\s+)(?:INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|INT\.?\s+EXT\.?)${SEP}`, 'i'), '#$1내부/외부'],
  [new RegExp(String.raw`^#(\s+)INT${SEP}`, 'i'), '#$1내부'],
  [new RegExp(String.raw`^#(\s+)EXT${SEP}`, 'i'), '#$1외부'],
]

function fix(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  let changed = 0
  const out = lines.map(l => {
    if (!l.startsWith('# ')) return l
    let s = l
    for (const [re, to] of RULES) {
      if (re.test(s)) { s = s.replace(re, to); break }
    }
    // 헤딩 중간에 남은 경우도 있다: `# 내부. 대니의 트럭/EXT. 주택가 거리`
    s = s.replace(/([\/·]\s*)INT(\.?)(?=$|[\s.:;,–—-]|[가-힣])/gi, '$1내부$2')
         .replace(/([\/·]\s*)EXT(\.?)(?=$|[\s.:;,–—-]|[가-힣])/gi, '$1외부$2')
    if (s !== l) { changed++; return s }
    return l
  })
  if (WRITE && changed) {
    if (!existsSync(path + '.hpbak')) copyFileSync(path, path + '.hpbak')
    writeFileSync(path, out.join('\n'))
  }
  return changed
}

const works = ALL ? readdirSync(CONTENT) : [only]
let total = 0, hit = 0
for (const w of works) {
  let files
  try { files = readdirSync(join(CONTENT, w)) } catch { continue }
  const f = files.find(x => /_translated\.txt$/.test(x))
  if (!f) continue
  const n = fix(join(CONTENT, w, f))
  if (n) { console.log(`  ${w.padEnd(36)} ${n}`); total += n; hit++ }
}
console.log(`\n총 ${total}건 · ${hit}편${WRITE ? '' : '  (--write 없음 — 저장 안 함)'}`)
