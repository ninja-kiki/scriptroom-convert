// 원문(EN)·번역(KO)의 씬별 블록 종류 순서(헤딩·인물·대사·괄호·지문)가 같은 씬 비율(%)과 메타 응답 줄 수.
//   리더는 두 쪽 블록을 순서로 짝지으므로 이게 낮으면 대사가 엉뚱한 인물 밑에 붙는다.
//   사용: node tools/struct-match.mjs <작품폴더>   →  "일치% 메타줄수"
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { metaLeak } from '../src/lib/meta-leak.js'

const dir = join('/Users/hojun/Projects/scriptroom/content', process.argv[2])
const pick = re => join(dir, readdirSync(dir).find(f => re.test(f)))
const kind = s => s.startsWith('#') ? 'S' : s.startsWith('@') ? 'C' : s.startsWith('- ') ? 'D' : (s.startsWith('(') && s.endsWith(')')) ? 'P' : 'A'
const scenes = t => {
  const out = [[]]
  for (const l of t.split('\n')) { const s = l.trim(); if (!s) continue; if (s.startsWith('#')) out.push([]); out[out.length - 1].push(kind(s)) }
  return out.map(x => x.join(''))
}
const tr = readFileSync(pick(/_translated\.txt$/), 'utf8')
const a = scenes(readFileSync(pick(/_formatted\.txt$/), 'utf8')), b = scenes(tr)
const n = Math.min(a.length, b.length)
let same = 0
for (let i = 0; i < n; i++) if (a[i] === b[i]) same++
console.log(`${Math.floor(100 * same / Math.max(n, 1))} ${tr.split('\n').filter(metaLeak).length}`)
