// 영어로 남은 인물 큐 이름만 모아 '작품당 1회' 번역해 사전을 만들고, 그 사전으로 전량 치환한다.
//   왜: 씬을 통째로 재번역하면 비싸지만, 인물 이름은 목록 하나만 옮기면 되므로 호출 1번이면 끝난다.
//   사용: node tools/make-cue-dict.mjs <작품폴더> [--write]
//
// 안전 원칙:
//   · 이름 개수와 응답 줄 수가 다르면 적용하지 않는다.
//   · 응답이 여전히 영어인 항목은 건너뛴다(잘못 덮어쓰기 방지).
//   · V.O./O.S./CONT'D 등 수식어는 영어 그대로 유지한다.
//   · 역할명(COP, BARTENDER)은 한국어 역할어로, 고유명은 통용 음차로 옮기도록 지시한다.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/make-cue-dict.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const trFile = readdirSync(dir).find(f => /_translated\.txt$/.test(f))
if (!trFile) { console.error('_translated.txt 없음'); process.exit(1) }
const trPath = join(dir, trFile)
const lines = readFileSync(trPath, 'utf8').split('\n')

const SUFFIX = /\s*\((V\.?O\.?|O\.?S\.?|CONT['’]?D|CONTD|MORE|CONTINUED|PRE-?LAP|OVER RADIO|OVER COMMS|ON PHONE|filtered)[^)]*\)\s*$/i
const splitCue = s => {
  const body = s.replace(/^@/, '')
  const m = body.match(SUFFIX)
  return { name: (m ? body.slice(0, m.index) : body).trim(), suffix: m ? m[0].trim() : '' }
}

// 영어로 남은 고유한 이름 수집
const names = []
const seen = new Set()
for (const l of lines) {
  const s = l.trim()
  if (!s.startsWith('@')) continue
  const { name } = splitCue(s)
  if (!name || /[가-힣]/.test(name)) continue
  if (seen.has(name)) continue
  seen.add(name); names.push(name)
}
if (!names.length) { console.log(`${work}: 영어 큐 없음`); process.exit(0) }
console.log(`${work}: 영어 이름 ${names.length}종`)

const sys = `당신은 영화 각본 번역가입니다. 아래는 어떤 각본의 '등장인물 큐 이름' 목록입니다. 각 줄을 한국어로 옮기세요.

규칙(엄수):
- 입력 줄 수와 똑같은 줄 수로 출력. 번호·설명·따옴표 없이 이름만.
- 고유명(인물 이름)은 외래어 표기법에 맞는 통용 음차로: MARK→마크, YINSEN→인센, RAZA→라자.
- 역할명은 한국어 역할어로: COP→경찰, BARTENDER→바텐더, WOMAN→여자, GRUFF MAN→퉁명스러운 남자, VOICE→목소리.
- 번호가 붙으면 유지: COP 1→경찰 1.
- 이미 한국어면 그대로 두세요.
- 사람 이름이 아닌 표기(OMIT, CONTD, WIDER, THEN 같은 편집 표시)는 그대로 두세요.`

const res = await fetch(`${SERVER}/api/translate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ formattedText: names.join('\n'), guidelines: sys, sceneIndex: 0, totalScenes: 1 }),
})
if (!res.ok) { console.error(`번역 실패: ${res.status}`); process.exit(1) }
const out = ((await res.json()).translated || '').trim().split('\n').map(s => s.trim()).filter(Boolean)

if (out.length !== names.length) {
  console.error(`  줄 수 불일치(${out.length} ≠ ${names.length}) — 적용하지 않음`)
  process.exit(2)
}

// ★음차 타당성 검사 — 이름이 엉뚱한 사람으로 바뀌는 사고를 막는다.
//   실제로 'ANDREW → 마크'처럼 완전히 다른 이름이 나온 적이 있다(위플래쉬).
//   영문 이름의 첫 자음/모음 계열이 한글 초성과 대략이라도 맞는지 본다. 안 맞으면 채택하지 않는다.
const INITIAL = {
  A:'ㅇ', E:'ㅇ', I:'ㅇ', O:'ㅇ', U:'ㅇ', Y:'ㅇ', H:'ㅎ',
  B:'ㅂ', P:'ㅍ', V:'ㅂ', F:'ㅍ', M:'ㅁ',
  C:'ㅋ', K:'ㅋ', G:'ㄱ', Q:'ㅋ',
  D:'ㄷ', T:'ㅌ', N:'ㄴ', L:'ㄹ', R:'ㄹ',
  S:'ㅅ', Z:'ㅈ', J:'ㅈ', X:'ㅅ', W:'ㅇ',
}
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
const choOf = ch => {
  const c = ch.charCodeAt(0) - 0xAC00
  return (c >= 0 && c <= 11171) ? CHO[Math.floor(c / 588)] : null
}
const NEAR = { 'ㄱ':'ㅋㄲ', 'ㅋ':'ㄱㄲ', 'ㄷ':'ㅌㄸ', 'ㅌ':'ㄷㄸ', 'ㅂ':'ㅍㅃ', 'ㅍ':'ㅂㅃ',
               'ㅅ':'ㅆㅈㅊ', 'ㅈ':'ㅉㅊㅅ', 'ㅊ':'ㅈㅅ', 'ㄹ':'ㄴ', 'ㄴ':'ㄹ', 'ㅇ':'ㅎ', 'ㅎ':'ㅇ' }
function plausible(en, ko) {
  // 'MR. KRAMER → 크레이머 씨', 'UNCLE FRANK → 프랭크 삼촌'처럼 호칭이 앞뒤로 붙는 경우가 있어
  // 영문의 각 단어 첫 글자와 한글의 각 어절 초성을 모두 대조해 하나라도 맞으면 통과시킨다.
  const enWords = en.split(/[\s.]+/).filter(w => /[A-Za-z]/.test(w))
  const koWords = ko.split(/\s+/).filter(Boolean)
  if (!enWords.length || !koWords.length) return true
  for (const w of enWords) {
    const want = INITIAL[w.toUpperCase()[0]]
    if (!want) continue
    for (const kw of koWords) {
      const k = [...kw].find(c => choOf(c))
      if (!k) continue
      const got = choOf(k)
      if (got === want || (NEAR[want] || '').includes(got)) return true
    }
  }
  return false
}

const dict = new Map()
const rejected = []
names.forEach((en, i) => {
  const ko = out[i]
  if (!ko || !/[가-힣]/.test(ko)) return       // 여전히 영어면 건너뜀
  if (/[一-鿿]/.test(ko)) return                // 한자 혼입 방지
  // 역할명·일반명사는 음차가 아니라 '뜻'으로 옮기는 게 정상이므로 음차 검사 대상이 아니다.
  //   (MAN→남자, ASSISTANT→조수처럼 초성이 안 맞는 게 당연하다)
  //   흔한 역할 어휘 목록으로 걸러내고, 나머지 고유명에만 음차 검사를 적용한다.
  const ROLE = /\b(MAN|WOMAN|BOY|GIRL|GUY|LADY|KID|CHILD|COP|POLICE|OFFICER|GUARD|DOCTOR|NURSE|DRIVER|WAITER|WAITRESS|BARTENDER|CLERK|TEACHER|STUDENT|PLAYER|PLAYERS|ASSISTANT|TECHNICIAN|PASSERBY|BYSTANDER|CROWD|ALL|VOICE|NARRATOR|ANNOUNCER|REPORTER|SOLDIER|AGENT|PILOT|CAPTAIN|SERGEANT|GENERAL|SECRETARY|RECEPTIONIST|CUSTODIAN|CUSTOMER|NEIGHBOR|MOTHER|FATHER|MOM|DAD|SON|DAUGHTER|BROTHER|SISTER|WIFE|HUSBAND|FRIEND|STRANGER|WORKER|MANAGER|OWNER|HOST|GUEST|JUDGE|LAWYER|PRIEST|ATTENDANT|OPERATOR|ENGINEER|SCIENTIST|MEDIC|CREW|MEMBER|LEADER|HAND|STAFF|EXTRA|FIGURE|SHADOW|BODY|FACE)\b/i
  const isProper = /^[A-Z][A-Za-z.'’-]*(\s+[A-Z][A-Za-z.'’-]*)?$/.test(en) && en.length <= 18 && !ROLE.test(en)
  if (isProper && !plausible(en, ko)) { rejected.push(`${en} → ${ko}`); return }
  dict.set(en, ko)
})
if (rejected.length) {
  console.warn(`  ⚠ 음차 불일치로 제외 ${rejected.length}건: ${rejected.slice(0, 5).join(', ')}`)
}
console.log(`  사전 ${dict.size}/${names.length}개 확보`)
;[...dict].slice(0, 5).forEach(([a, b]) => console.log(`    ${a} → ${b}`))

let changed = 0
const result = lines.map(l => {
  const s = l.trim()
  if (!s.startsWith('@')) return l
  const { name, suffix } = splitCue(s)
  const ko = dict.get(name)
  if (!ko) return l
  changed++
  return '@' + ko + (suffix ? ' ' + suffix : '')
})
console.log(`  치환 ${changed}개`)

if (WRITE && changed) {
  if (!existsSync(trPath + '.dictbak')) copyFileSync(trPath, trPath + '.dictbak')
  writeFileSync(trPath, result.join('\n'))
  console.log(`  ✓ 저장 (백업: .dictbak)`)
} else if (!WRITE) {
  console.log('  (--write 없음 — 저장 안 함)')
}
