// 괄호에 갇힌 인물 큐를 되돌린다.
//
//   왜 갇혔나: 전환 지시어 판정 틀이 조각마다 '있어도 되고 없어도 되는' 구조라
//   'TOM'이 TO+M, 'ONA'가 ON+A 로 맞아떨어져 전환으로 분류됐다. 전환은 괄호를 씌워
//   내보내므로 인물 큐가 '(TOM)'이 됐다(리플리 119개, 우먼 토킹 82개).
//   판정 틀 자체는 pdf-reformat/text-reformat 에서 고쳤다. 이 도구는 이미 그렇게
//   나가버린 파일을 되돌린다 — 다시 번역하지 않고도 구조가 복구되기 때문이다.
//
//   ★건드릴 대상을 '뒤에 대사가 오는 괄호'로 잡으면 안 된다. '(beat)'·'(부드럽게)' 같은
//   진짜 연기 지시도 뒤에 대사가 온다(그렇게 잡았다가 172개를 잘못 바꿀 뻔했다).
//   되돌릴 것은 '옛 규칙이 전환으로 오판했을 이름'뿐이므로, 그 옛 규칙을 그대로 들고 와서
//   '옛 규칙은 전환이라 했지만 새 규칙은 아니라 하는' 것만 고른다. 원인과 대상이 같아진다.
//
//   번역본 쪽은 이름이 한국어라 그 판정을 쓸 수 없다. 대신 원문에서 찾은 이름의 '횟수'를
//   근거로 짝을 찾는다 — 119번 갇힌 TOM 의 짝은 119번 나오는 (톰)이다.
//
//   사용: node tools/fix-cue-parens.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/fix-cue-parens.mjs <작품폴더> [--write]'); process.exit(1) }

// 사고를 낸 옛 판정 틀 그대로
const OLD_SHAPE = /^(?:(?:SMASH|MATCH|JUMP|HARD|QUICK|TIME|SLAM|SNAP|ROTATE|LONG)(?:\s+CUT)?\s+)?(?:CUT|DISSOLVE|FADE|WIPE|TRANSITION|FLASH(?:\s+BACK)?)?(?:\s*(?:TO|IN|OUT|UP|BACK|ON))*(?:\s+BLACK|\s+WHITE)?\s*:?\s*\d{0,4}[A-Z]?\s*\*?\s*$/i
const TRANS_WORD = /\b(CUT|DISSOLVE|FADE|WIPE|TRANSITION|FLASH)\b/i
const TRANS_COLON = /:\s*\d{0,4}[A-Z]?\s*\*?\s*$/
// ★'(to TOM)'도 옛 규칙에 걸린다(to + TO + M). 하지만 그건 말 거는 상대를 적은 진짜 연기
//   지시다 — 뒤에 대사가 오는 것도 정상이라 위치로는 구분되지 않는다(시카고 7에서 이걸로
//   57개를 잘못 바꿀 뻔했다). 인물 큐는 이름만 대문자로 적으므로 그 조건을 함께 건다.
const isNameShape = (s) => {
  const L = s.replace(/[^A-Za-z]/g, ''), U = s.replace(/[^A-Z]/g, '')
  return L.length >= 2 && U.length / L.length >= 0.9
}
const wasMisread = (s) => OLD_SHAPE.test(s) && !TRANS_WORD.test(s) && !TRANS_COLON.test(s) && isNameShape(s)

const dir = join(CONTENT, work)
const read = (kind) => {
  const file = readdirSync(dir).find(f => f.endsWith(kind))
  if (!file) return null
  const path = join(dir, file)
  return { path, lines: readFileSync(path, 'utf8').split('\n') }
}
const save = (o, tag) => {
  if (!WRITE) return
  if (!existsSync(o.path + tag)) copyFileSync(o.path, o.path + tag)
  writeFileSync(o.path, o.lines.join('\n'))
}
const nextContent = (lines, i, step) => {
  for (let j = i + step; j >= 0 && j < lines.length; j += step) if (lines[j].trim()) return lines[j].trim()
  return ''
}
const parenAt = (l) => { const m = l.trim().match(/^\((.{1,30})\)$/); return m ? m[1].trim() : null }

// ── 원문: 옛 규칙이 오판했을 이름만 되돌린다
const en = read('_formatted.txt')
if (!en) { console.error('formatted 없음'); process.exit(1) }
const trapped = {}
for (let i = 0; i < en.lines.length; i++) {
  const name = parenAt(en.lines[i])
  if (!name || !wasMisread(name)) continue
  if (!nextContent(en.lines, i, 1).startsWith('- ')) continue   // 뒤에 대사가 와야 큐다
  en.lines[i] = '@' + name
  trapped[name] = (trapped[name] || 0) + 1
}
const enTotal = Object.values(trapped).reduce((a, b) => a + b, 0)
if (!enTotal) { console.log('  갇힌 큐 없음'); process.exit(0) }
console.log(`  원문: ${enTotal}개 복구 — ${Object.entries(trapped).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ')}`)
save(en, '.cpbak')

// ── 번역본: 원문에서 찾은 횟수와 짝이 맞는 괄호만 되돌린다
const ko = read('_translated.txt')
if (!ko) process.exit(0)
const counts = {}
for (const l of ko.lines) { const p = parenAt(l); if (p) counts[p] = (counts[p] || 0) + 1 }
const wanted = Object.values(trapped).filter(n => n >= 5)
const near = (n) => wanted.some(w => Math.abs(n - w) <= Math.max(2, w * 0.15))
const koNames = Object.keys(counts).filter(p => near(counts[p]))
if (!koNames.length) { console.log('  번역본: 짝이 되는 괄호를 못 찾음 — 손대지 않음'); process.exit(0) }
const done = {}
for (let i = 0; i < ko.lines.length; i++) {
  const p = parenAt(ko.lines[i])
  if (!p || !koNames.includes(p)) continue
  if (!nextContent(ko.lines, i, 1).startsWith('- ')) continue
  ko.lines[i] = '@' + p
  done[p] = (done[p] || 0) + 1
}
console.log(`  번역본: ${Object.values(done).reduce((a, b) => a + b, 0)}개 복구 — ${Object.entries(done).map(([k, n]) => `${k}×${n}`).join(', ')}`)
save(ko, '.cpbak')
if (!WRITE) console.log('  (--write 없음 — 저장 안 함)')
