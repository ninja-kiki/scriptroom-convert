// 리더기에서 사람이 직접 고친 내용(검수노트)을 번역본 원문(_translated.txt)에 되먹인다.
//   왜 JSON이 아니라 txt인가: src/data/<id>.json 의 블록 id는 챕터별 순번(ch2b6)이라
//   RESYNC 한 번이면 다시 만들어진다. json만 고치면 다음 재처리에서 통째로 날아간다.
//
//   사용: node tools/apply-review-notes.mjs <검수노트.txt> [작품id] [--write]
//
// 안전 원칙
//   - '원본' 문자열이 번역본에 정확히 1번 나올 때만 고친다(0번=이미 바뀜, 2번 이상=어디인지 모름 → 건너뜀).
//   - 검수노트는 7/26 기준이고 그 뒤 재번역이 돌았다. 어긋난 항목은 손대지 않고 목록으로 남긴다.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const [notePath, ...rest] = process.argv.slice(2)
const WRITE = rest.includes('--write')
const ONLY = rest.find(a => !a.startsWith('--'))
if (!notePath) { console.error('사용: node tools/apply-review-notes.mjs <검수노트.txt> [작품id] [--write]'); process.exit(1) }

// 검수노트의 블록 종류 → 번역본에서의 표기
const MARK = {
  '대사': s => '- ' + s,
  '지문': s => s,
  '인물': s => '@' + s.replace(/^@/, ''),
  '괄호': s => (/^\(/.test(s) ? s : `(${s})`),
  '씬': s => '# ' + s.replace(/^#+\s*/, ''),
  'transition': s => s,
}

const note = readFileSync(notePath, 'utf8')
const parts = note.split(/^=== (.+?) \(id: (.+?)\) ===$/m)

// 작품 폴더는 id와 폴더명이 다를 수 있어 content 안에서 찾는다
const dirs = readdirSync(CONTENT)
const findDir = id => dirs.find(d => d === id) || dirs.find(d => d.toLowerCase() === id.toLowerCase())

const summary = []
for (let i = 1; i < parts.length; i += 3) {
  const [name, id, body] = [parts[i], parts[i + 1], parts[i + 2]]
  if (ONLY && id !== ONLY) continue
  const dir = findDir(id)
  if (!dir) { summary.push({ id, applied: 0, skipped: 0, note: '폴더 없음' }); continue }
  const files = readdirSync(join(CONTENT, dir))
  const trFile = files.find(f => /_translated\.txt$/.test(f))
  if (!trFile) { summary.push({ id, applied: 0, skipped: 0, note: '번역본 없음' }); continue }
  const path = join(CONTENT, dir, trFile)
  let text = readFileSync(path, 'utf8')

  // '## 수정' 섹션만 대상 ('노트 · 보관'은 사람이 남긴 메모라 자동 반영 대상이 아니다)
  const fixSec = body.split('## 노트')[0]
  const items = [...fixSec.matchAll(/^\[id:([^\s·]+)[^\]]*·([^\]]+?)\](\s*구조 변경)?\n원본:\s*([\s\S]*?)\n수정:\s*([\s\S]*?)(?=\n---|\n##|\n===|$)/gm)]

  let applied = 0
  const skipped = []
  for (const m of items) {
    const [, bid, kind, isStruct, origRaw, fixRaw] = m
    const orig = origRaw.trim()
    if (!orig) { skipped.push(`${bid} 원본 없음`); continue }

    // 바뀔 내용을 번역본 표기로 조립
    let replacement
    if (isStruct) {
      const rows = [...fixRaw.matchAll(/·\s*\[(\S+?)\]\s*(.*)/g)].map(r => {
        const f = MARK[r[1]] || (s => s)
        return f(r[2].trim())
      })
      if (!rows.length) { skipped.push(`${bid} 수정 파싱 실패`); continue }
      replacement = rows.join('\n\n')
    } else {
      const one = fixRaw.trim()
      if (!one) { skipped.push(`${bid} 수정 비어 있음`); continue }
      replacement = one
    }

    // 원본이 번역본에 정확히 한 번만 나올 때만 교체
    const n = text.split(orig).length - 1
    if (n !== 1) { skipped.push(`${bid} ${n === 0 ? '원본 못 찾음(재번역으로 바뀜)' : `원본 ${n}곳 중복`}`); continue }
    text = text.replace(orig, replacement)
    applied++
  }

  if (WRITE && applied) {
    if (!existsSync(path + '.notebak')) copyFileSync(path, path + '.notebak')
    writeFileSync(path, text)
  }
  summary.push({ id, name, applied, skipped: skipped.length, detail: skipped })
}

let A = 0, S = 0
for (const s of summary) {
  A += s.applied; S += s.skipped
  console.log(`  ${s.id.padEnd(30)} 반영 ${String(s.applied).padStart(3)} · 건너뜀 ${String(s.skipped).padStart(3)}${s.note ? ' · ' + s.note : ''}`)
  if (process.env.VERBOSE) s.detail?.slice(0, 5).forEach(d => console.log(`      - ${d}`))
}
console.log(`\n총 반영 ${A} · 건너뜀 ${S}${WRITE ? '' : '  (--write 없음 — 저장 안 함)'}`)
