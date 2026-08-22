// 내용 없이 헤딩만 있는 '유령 씬'을 찾는다 — 번역기 지시문이 헤딩 자리에
//   새어 나온 자리는 몸통이 통째로 빈 채로 다음 헤딩이 바로 이어진다.
//   (오늘 top-gun-maverick·lady-bird·brads-status·memento·la-la-land에서
//   전부 이 형태였다.) 손으로 하나씩 찾는 대신 훑어서 후보를 보여준다.
//
//   사용: node tools/find-ghost-scenes.mjs <작품폴더>
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const dir = join(CONTENT, work)
const t = readdirSync(dir).find(f => f.endsWith('_translated.txt'))
const L = readFileSync(join(dir, t), 'utf8').split('\n')
let n = 0
for (let i = 0; i < L.length; i++) {
  if (!L[i].startsWith('# ')) continue
  let j = i + 1
  while (j < L.length && L[j].trim() === '') j++
  if (j >= L.length || L[j].startsWith('# ')) {
    n++
    console.log(`  줄${i + 1}: ${L[i].trim().slice(0, 70)}`)
  }
}
if (!n) console.log('  빈 유령 씬 없음')
