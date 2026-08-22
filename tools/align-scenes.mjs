// EN/KO 씬을 '지문 내용'으로 직접 정렬한다 — 헤딩이 아니라 본문으로.
//
//   왜 헤딩 비교로 안 되나: 액션 영화는 한 시퀀스 안에서 같은 장소가 여러 번
//   반복된다(아이언맨 콘서트홀 장면만 5번). 헤딩 텍스트나 숫자만 봐서는
//   그중 몇 번째인지 구분이 안 된다.
//
//   그래서 지문 줄의 '길이 지문(fingerprint)'으로 맞춘다 — 각 씬의 지문 길이
//   합계는 번역해도 원문과 대체로 비례한다(±40% 안쪽). LCS(최장 공통 부분수열)로
//   EN 씬 순서와 KO 씬 순서를 정렬해서, 어디서 끼워넣기·건너뛰기가 일어났는지 찾는다.
//
//   사용: node tools/align-scenes.mjs <작품폴더>
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
if (!work) { console.error('사용: node tools/align-scenes.mjs <작품폴더>'); process.exit(1) }
const dir = join(CONTENT, work)

const OMIT = /^#\s*(생략|삭제됨|삭제|OMITT?E?D?)\s*$/i

function scenes(p) {
  const lines = readFileSync(join(dir, p), 'utf8').split('\n')
  const out = []
  let cur = null
  for (const l of lines) {
    if (l.startsWith('# ')) {
      if (cur) out.push(cur)
      if (OMIT.test(l.trim())) { cur = null; continue }
      cur = { head: l.trim(), body: '', len: 0 }
      continue
    }
    if (!cur) continue
    if (l.startsWith('@') || l.startsWith('- ') || l.startsWith('(')) continue  // 대사/큐/괄호는 뺀다 — 지문 길이만
    cur.body += l
    cur.len += l.length
  }
  if (cur) out.push(cur)
  return out
}

const ff = readdirSync(dir).find(f => f.endsWith('_formatted.txt'))
const tf = readdirSync(dir).find(f => f.endsWith('_translated.txt'))
const en = scenes(ff), ko = scenes(tf)
console.log(`EN ${en.length}개 · KO ${ko.length}개`)

// 길이비 0.3~3.0 이내면 '같은 씬일 수 있다'로 본다(한국어가 대체로 더 짧다)
const similar = (a, b) => {
  if (a.len < 5 && b.len < 5) return true
  const r = b.len / Math.max(a.len, 1)
  return r >= 0.25 && r <= 2.8
}

// LCS 정렬(DP) — EN[i] ↔ KO[j] 짝을 최대한 많이 찾는다
const n = en.length, m = ko.length
const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1))
for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
  dp[i][j] = similar(en[i], ko[j])
    ? dp[i + 1][j + 1] + 1
    : Math.max(dp[i + 1][j], dp[i][j + 1])
}
let i = 0, j = 0
const insertedInKo = [], missingFromKo = []
while (i < n && j < m) {
  if (similar(en[i], ko[j])) { i++; j++; continue }
  if (dp[i + 1][j] >= dp[i][j + 1]) { missingFromKo.push({ i, head: en[i].head }); i++ }
  else { insertedInKo.push({ j, head: ko[j].head }); j++ }
}
while (i < n) { missingFromKo.push({ i, head: en[i].head }); i++ }
while (j < m) { insertedInKo.push({ j, head: ko[j].head }); j++ }

console.log(`\nKO에 남는(EN에 짝 없음) ${insertedInKo.length}개:`)
for (const x of insertedInKo) console.log(`  KO#${x.j + 1}  ${x.head.slice(0, 60)}`)
console.log(`\nEN에 있는데 KO에 없음 ${missingFromKo.length}개:`)
for (const x of missingFromKo) console.log(`  EN#${x.i + 1}  ${x.head.slice(0, 60)}`)
