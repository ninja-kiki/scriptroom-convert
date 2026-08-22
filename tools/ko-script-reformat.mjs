// 한국어 제작 각본을 리더 형식으로 옮긴다.
//
//   영어 각본과 무엇이 다른가:
//     · 번역 단계가 없다. 추출·청소만 하고 그대로 리더로 간다.
//     · 지문과 대사가 같은 줄머리에 붙어 있다. 영어 각본은 x좌표(지문 116·대사 188·인물 279)로
//       갈랐는데 여기는 그 근거가 아예 없다.
//     · 인물명과 대사가 한 줄에 있다 — '은주 여보세요? (약간 실망한 듯한)'.
//     · 편지 낭독·내레이션은 '은주 소리>' 뒤로 여러 줄이 이어진다(시월애 68곳).
//     · 연출 용어는 원래 영어다(Camera movement · C.U. · FADE OUT.) — 그대로 살린다.
//
//   무엇으로 지문과 대사를 가르나:
//     ① 줄이 등장인물 이름으로 시작하고 바로 뒤가 공백/괄호면 대사 후보.
//        이름 뒤에 조사나 쉼표가 붙으면 지문이다('은주, 후다닥' · '은주가 안고').
//     ② 한국어 각본의 지문은 현재형 서술로 끝난다(-ㄴ다/는다/한다). 대사는 거의 그렇지 않다.
//        이 각본에서 지문의 37%가 '다'로 끝났고 대사는 9%뿐이었는데, 그 9%조차 대부분
//        '성현(27세), 뒤로 물러서서…' 같은 오분류였다. ①만으로는 이런 걸 못 걸러 ②를 함께 본다.
//     인물 목록이 있어야 ①이 성립한다 — 각본 앞머리의 '등장 인물'에서 읽어온다.
//
//   사용: node tools/ko-script-reformat.mjs <입력.txt|.rtf> <작품폴더>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const [input, work] = process.argv.slice(2)
if (!input || !work) { console.error('사용: node tools/ko-script-reformat.mjs <입력> <작품폴더>'); process.exit(1) }

let raw = input.toLowerCase().endsWith('.rtf')
  ? execSync(`textutil -convert txt -stdout ${JSON.stringify(input)}`, { encoding: 'utf8', maxBuffer: 64 << 20 })
  : readFileSync(input, 'utf8')

// ── 청소 ────────────────────────────────────────────────
// 전각 공백(U+3000)만 있는 줄은 빈 줄이다
let lines = raw.split('\n').map(l => l.replace(/　/g, ' ').replace(/[ \t]+$/, ''))

// 줄이 제 앞머리를 다시 시작하면 앞을 버린다 — 워드가 페이지 머리글을 본문에 두 번 찍는다
//   ('첫 키스를 기억하십니까첫 키스를 기억하십니까...')
const HEAD = 12
let dedup = 0
lines = lines.map(l => {
  const s = l.trim()
  if (s.length < HEAD * 2) return l
  const again = s.indexOf(s.slice(0, HEAD), 1)
  if (again < HEAD) return l
  dedup++
  return s.slice(again)
})

// 페이지마다 찍힌 제목이 본문 줄 끝에 붙어 온다('#1. … (3시경)時 越 愛')
const titleRuns = {}
for (const l of lines) for (const m of l.matchAll(/[一-鿿][一-鿿\s]{2,20}/g)) {
  const k = m[0].trim(); titleRuns[k] = (titleRuns[k] || 0) + 1
}
const stamp = Object.entries(titleRuns).filter(([, n]) => n >= 3).map(([k]) => k)
let stamped = 0
if (stamp.length) lines = lines.map(l => {
  let o = l
  for (const s of stamp) if (o.includes(s) && o.trim() !== s) { o = o.split(s).join(''); stamped++ }
  return o.replace(/[ \t]+$/, '')
})

// 내레이션·편지 낭독 표시. 표기가 제각각이라 한 틀로 받고 이름만 추린다.
//   '은주 소리>' · '은주소리>' · '성현의 목소리>' · '성현 목소리>' · '은주더빙소리>' · 'DJ소리>'
const VOICE = /^(.{1,12}?)\s*(?:더빙)?\s*(?:목)?소리\s*>\s*(.*)$/
const voiceName = (s) => s.replace(/\([^)]*\)/g, '').replace(/\s*의$/, '').trim()
// '여자소리(o.s.)' 처럼 이름과 '소리'가 한 낱말로 붙어 쓰이기도 한다 — 이름만 남긴다.
const SOUND_SUFFIX = /\s*(?:의)?\s*(?:더빙)?\s*(?:목)?소리$/
const bareName = (s) => { const t = s.replace(SOUND_SUFFIX, '').trim(); return t.length >= 1 ? t : s }

// 지문은 현재형 서술로 끝난다 — 이름 탐색에도 쓰이므로 먼저 둔다
const NARR_PROBE = /(다|었다|한다|된다|든다|온다|간다|난다|린다|킨다|친다|뜬다)$/

// ── 앞머리(연출 노트·등장 인물)와 본문을 가른다 ──────────────
const SCENE = /^#\s*(\d{1,3})\.?\s*(.*)$/
const first = lines.findIndex(l => SCENE.test(l.trim()))
if (first < 0) { console.error('씬 번호(#N)를 못 찾음'); process.exit(1) }
const front = lines.slice(0, first), body = lines.slice(first)

// 등장 인물: '이름 - 설명' 형태의 줄에서 이름만 거둔다
const cast = []
for (const l of front) {
  const m = l.trim().match(/^([가-힣A-Za-z0-9 ]{1,12}?)\s*[-–]\s*\S/)
  if (m && !/^[-–]/.test(m[1])) cast.push(m[1].trim())
}
// '한석진 교수' 처럼 붙어 나오는 이름은 앞 낱말도 후보로 넣는다
// ★앞머리 목록에는 주요 인물만 적혀 있다. 운전기사·성우1·어머니처럼 말은 하는데
//   목록에 없는 사람이 많아서, 그들의 대사가 통째로 지문으로 남았다.
//   그래서 본문에서도 이름을 찾아낸다 — 근거는 '말한다는 표시'뿐이다:
//     · 화면 밖 표시가 붙은 것            운전기사(o.s) …
//     · 소리> 표시가 붙은 것              은주 소리>
//     · 줄머리에 거듭 나오고 뒤가 서술형이 아닌 것  (3회 이상일 때만)
//   이름 목록을 손으로 적지 않는다 — 각본마다 등장인물이 다르므로 문서가 스스로 말하게 한다.
const found = new Set(cast.flatMap(n => n.includes(' ') ? [n, n.split(' ')[0]] : [n]))
for (const l of body) {
  const s = l.trim()
  let m = s.match(/^([가-힣A-Za-z0-9]{2,10})\s*\((?:o\.?s|v\.?o|n\.?a|f|e|filter|소리|필터)[^)]*\)/i)
  if (m) { found.add(bareName(m[1])); continue }
  // 표기가 제각각이다: '은주 소리>' · '은주소리>' · '성현의 목소리>' · '은주더빙소리>' · 'DJ소리>'
  m = s.match(VOICE)
  if (m) found.add(bareName(voiceName(m[1])))
}
// 표시가 없는 사람은 '말투'로 찾는다 — 줄머리 낱말 뒤에 오는 말이 대화체로 끝나는 경우를 센다.
//   ★그냥 자주 나오는 낱말을 세면 '카메라'·'천천히'·'갑자기'가 인물이 된다(실제로 그랬다).
//   말투를 보면 그런 건 서술형으로 끝나서 걸리지 않는다.
//   남는 잡음은 낱말 자체가 조사로 끝나는 것들이다('녹음기는 …', '편지가 …') — 그건 이름이 아니다.
const SPEECH = /(요|까|야|니|네|죠|자|래|군|데|지|어|아|만)[.?!…~]*$/
const TAIL_JOSA = /[은는이가을를의도와과로게서고며에]$/
const conv = {}
for (const l of body) {
  const m = l.trim().match(/^([가-힣A-Za-z0-9]{2,8})\s+(\S.*)$/)
  if (!m) continue
  const rest = m[2]
  if (/^[은는이가을를의도와과에서로만]/.test(rest) || rest.startsWith(',')) continue
  const tail = rest.replace(/\([^)]*\)\s*$/, '').replace(/[\s.!?…"'’”)~]+$/, '')
  if (NARR_PROBE.test(tail) || !SPEECH.test(tail)) continue
  conv[m[1]] = (conv[m[1]] || 0) + 1
}
const guessed = [], rejected = []
for (const [n, c] of Object.entries(conv)) {
  if (c < 2 || found.has(n)) continue
  ;(TAIL_JOSA.test(n) ? rejected : guessed).push(`${n}(${c})`)
}
if (rejected.length) console.log(`  이름이 아니라고 본 것: ${rejected.join(', ')}`)
// '문장 속 대상으로 나오면 지문' 판정에는 앞머리 목록의 고유명만 쓴다.
//   본문에서 찾은 배역에는 '여자'·'친구'·'기사'처럼 보통명사가 섞여 있어서,
//   그걸로 판정하면 멀쩡한 대사가 지문이 된다('사랑하는 여자를 위해서 설계한 집이거든요').
const PROPER = [...new Set(cast.flatMap(n => n.includes(' ') ? [n, n.split(' ')[0]] : [n]))].filter(n => n.length >= 2)
const NAMES = [...new Set([...found, ...guessed.map(x => x.replace(/\(\d+\)$/, ''))])].filter(n => n.length >= 2).sort((a, b) => b.length - a.length)
console.log(`등장 인물 ${NAMES.length}명 — 목록 ${cast.length} · 본문에서 더 찾음 ${NAMES.length - new Set(cast).size}`)
console.log(`  ${NAMES.join(', ')}`)

// ── 판정 ────────────────────────────────────────────────
const JOSA = /^[은는이가을를의도와과에서로만보다처럼부터까지]/
const NARR = /(다|다\.|다\.\.\.|었다|한다|된다|든다|온다|간다|난다|린다|킨다|친다|뜬다|运)$/
// ★'-다'로 끝나면 지문이라고 했더니 격식체 대사가 전부 지문이 됐다
//   ('…오프닝 곡을 준비했습니다.' · '부탁드립니다.' · '녹음하겠습니다.').
//   '-니다/-니까'로 끝나는 말은 사람이 하는 말이지 지문이 아니다.
const POLITE = /(니다|니까|나요|가요)$/
const isNarr = (s) => { const t = s.replace(/[\s.!?…"'’”)~]+$/, ''); return NARR.test(t) && !POLITE.test(t) }
const AGE = /^\(\s*\d{1,2}\s*(세|살)/
// 'INSERT' · 'FADE OUT.' · 'C.U.' 같은 연출 지시 — 영어 그대로 살린다
const DIRECTION = /^(INSERT|CUT TO|FADE (IN|OUT)|DISSOLVE|F\.?O\.?|F\.?I\.?|C\.?U\.?|O\.?L\.?|MONTAGE|TITLE|CREDIT)\b/i

// 줄이 '이름 + 대사'인지 본다. 맞으면 [이름, 대사], 아니면 null
function asDialogue(s) {
  for (const n of NAMES) {
    if (!s.startsWith(n)) continue
    const rest = s.slice(n.length)
    if (!rest) return null
    if (rest[0] === ',' || JOSA.test(rest[0])) return null           // 은주, / 은주가 → 지문
    if (AGE.test(rest.trim())) return null                            // 성현(27세), … → 지문
    let body = rest.trim()
    let tag = ''
    // 이름 뒤에 바로 '소리'가 붙어 있으면(여자소리(o.s.)) 그건 이름의 일부가 아니라 화면 밖 표시다
    const snd = body.match(/^(?:의\s*)?(?:더빙)?(?:목)?소리\b/)
    if (snd) { tag = ' (소리)'; body = body.slice(snd[0].length).trim() }
    const t = body.match(/^\((o\.?s|v\.?o|n\.?a|f|e|filter|소리|필터)[^)]*\)/i)
    if (t) { tag = ' ' + t[0]; body = body.slice(t[0].length).trim() }
    if (!body) return null
    if (isNarr(body)) return null                                     // 서술형으로 끝나면 지문
    return [n + tag, body]
  }
  return null
}

// ── 조립 ────────────────────────────────────────────────
const out = []
// 빈 줄은 씬·인물 큐 앞에만 넣는다. 지문끼리 사이를 벌리면 원본의 문단 덩어리가 흩어진다.
const gap = () => { if (out.length && out[out.length - 1] !== '') out.push('') }
const push = (s) => out.push(s)
// 대사 줄을 낼 때 앞뒤 괄호(연기 지시)를 따로 떼어 낸다
function emitDialogue(text) {
  let s = text.trim()
  const lead = s.match(/^\(([^)]{1,40})\)\s*/)
  if (lead) { out.push(`(${lead[1].trim()})`); s = s.slice(lead[0].length).trim() }
  const tail = s.match(/\s*\(([^)]{1,40})\)\s*$/)
  let after = null
  if (tail) { after = tail[1].trim(); s = s.slice(0, tail.index).trim() }
  if (s) out.push('- ' + s)
  if (after) out.push(`(${after})`)
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const review = []
let inVoice = null, scenes = 0, dias = 0

for (const rawLine of body) {
  const s = rawLine.trim()
  if (!s) { inVoice = null; continue }

  const sc = s.match(SCENE)
  if (sc) { inVoice = null; scenes++; gap(); push(`# ${sc[1]}. ${sc[2].trim()}`); out.push(''); continue }

  // '은주 소리>' — 뒤이어 여러 줄이 그 인물의 말이다
  const v = s.match(VOICE)
  if (v) {
    inVoice = voiceName(v[1])
    gap(); push('@' + inVoice + ' (소리)')
    if (v[2].trim()) { emitDialogue(v[2]); dias++ }
    continue
  }

  const d = asDialogue(s)
  if (d) { inVoice = null; gap(); push('@' + d[0]); emitDialogue(d[1]); dias++; continue }

  // 소리> 블록 안이면 뒤이은 줄도 그 사람의 말이다 — 어디서 끝나는지는 표시가 없다.
  //   ★서술형(-다)만으로는 부족했다. 한국어 지문은 명사로도 끝난다
  //   ('프라이팬을 꺼내 가스레인지 위에 올려놓는 성현.' — 이게 대사로 딸려 들어갔다).
  //   그래서 '말하는 사람이 아닌 인물이 문장 속 대상으로 나오면 지문'을 함께 본다.
  //   부르는 말은 제외한다('은주야!' · '아저씨...') — 물음표·느낌표로 끝나면 그냥 대사로 본다.
  if (inVoice && !DIRECTION.test(s) && !/^[<[]/.test(s)) {
    const others = PROPER.filter(n => n !== inVoice && s.includes(n))
    const asObject = others.some(n => new RegExp(escapeRe(n) + '(?:[의이가은는을를]|\\s+[가-힣]|\\.$)').test(s))
    const shout = /[?!~]$/.test(s.replace(/[\s."'’”)]+$/, '') + s.slice(-1))
    if (!isNarr(s) && (!asObject || shout)) { emitDialogue(s); dias++; continue }
    review.push(`${inVoice}\t${s}`)
  }

  // ★대사 다음에 곧바로 지문이 오면 빈 줄로 끊어야 한다. 안 그러면 컴파일러가
  //   '은주야!' 뒤의 지문 열다섯 줄을 대사 한 덩어리로 붙여 버린다(실제로 그랬다).
  const last = out[out.length - 1] || ''
  if (inVoice || last.startsWith('- ') || last.startsWith('(')) gap()
  inVoice = null
  push(s)
}

const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
const dir = join(CONTENT, work)
mkdirSync(dir, { recursive: true })
// 한국어 원본은 번역할 것이 없다. 리더는 formatted(원문)·translated(번역) 쌍을 요구하므로
//   같은 내용을 양쪽에 넣는다 — EN 토글을 켜도 한국어가 보인다(영어 원문이 없으니 정직한 상태다).
for (const suffix of ['_formatted.txt', '_translated.txt']) writeFileSync(join(dir, work + suffix), text)
if (front.some(l => l.trim())) writeFileSync(join(dir, 'frontmatter.txt'), front.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n')

if (review.length) {
  writeFileSync(join(dir, '확인필요.txt'),
    '# 소리> 블록 안에서 지문으로 본 줄 — 대사가 맞으면 알려주세요.\n# 인물<탭>줄\n' + review.join('\n') + '\n')
  console.log(`확인 필요 ${review.length}줄 → ${dir}/확인필요.txt`)
}
console.log(`씬 ${scenes} · 대사 ${dias} · 두 번 찍힌 줄 ${dedup} · 머리글 제거 ${stamped}`)
console.log(`→ ${dir}/${work}_{formatted,translated}.txt`)
