// 유럽식(프랑스어 등) 각본 PDF를 뽑는다 — 인물 큐와 대사가 같은 열에 있는 판형.
//
//   영어 각본과 무엇이 다른가:
//     · 헐리우드 판형은 지문·대사·인물이 각각 다른 x좌표에 있다(예: 116 / 188 / 279).
//       그래서 x만 보고 갈랐다.
//     · 이 판형은 지문(x=71)과 '대사 덩어리'(x=227) 둘뿐이다. 인물 큐도 대사와 같은 227에 있다.
//       큐는 그 덩어리의 첫 줄이면서 전부 대문자다 — 'MEDECIN LÉGISTE(OFF)'.
//     · 씬 헤딩도 다르다: '5-CHU GRENOBLE–INT/JOUR' (번호-장소–INT/EXT/시간).
//
//   왜 pdf-reformat 을 고치지 않았나: 그 파일은 지금 171편을 정상으로 뽑고 있다.
//   판형이 다른 한 편 때문에 그 판정을 건드리면 잘 되던 것이 깨진다.
//
//   사용: node tools/euro-pdf-reformat.mjs <작품폴더>
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
if (!work) { console.error('사용: node tools/euro-pdf-reformat.mjs <작품폴더>'); process.exit(1) }
const dir = join(CONTENT, work)
const pdfName = readdirSync(dir).find(f => f.toLowerCase().endsWith('.pdf'))
if (!pdfName) { console.error('PDF 없음'); process.exit(1) }

const doc = await getDocument({ data: new Uint8Array(readFileSync(join(dir, pdfName))), useSystemFonts: true }).promise

// ── 줄 모으기 ───────────────────────────────────────────
const lines = []
for (let p = 1; p <= doc.numPages; p++) {
  const tc = await (await doc.getPage(p)).getTextContent()
  const rows = {}
  for (const it of tc.items) {
    if (!it.str.trim()) continue
    const y = Math.round(it.transform[5])
    ;(rows[y] = rows[y] || []).push([it.transform[4], it.str])
  }
  for (const y of Object.keys(rows).map(Number).sort((a, b) => b - a)) {
    const r = rows[y].sort((a, b) => a[0] - b[0])
    const text = r.map(c => c[1]).join('').replace(/\s+/g, ' ').trim()
    if (text) lines.push({ x: Math.round(r[0][0]), y, page: p, text })
  }
}

// ── 열 찾기 ─────────────────────────────────────────────
const freq = {}
for (const l of lines) freq[l.x] = (freq[l.x] || 0) + 1
const peaks = Object.entries(freq).map(([x, n]) => [+x, n]).sort((a, b) => b[1] - a[1])
const main = peaks.filter(([, n]) => n >= lines.length * 0.05).map(([x]) => x).sort((a, b) => a - b)
if (main.length < 2) { console.error(`열을 못 찾음 (봉우리: ${peaks.slice(0, 5).map(p => p.join(':')).join(' ')})`); process.exit(1) }
const xAction = main[0], xSpeech = main[1]
console.error(`열: 지문 x=${xAction} · 대사 x=${xSpeech}  (${lines.length}줄, ${doc.numPages}쪽)`)

// 페이지마다 찍힌 머리글·꼬리글은 본문 열에 없다 — 그 밖의 x는 버린다
const TOL = 12
const inCol = (l, x) => Math.abs(l.x - x) <= TOL

// ── 판정 ────────────────────────────────────────────────
// 씬: '5-CHU GRENOBLE–INT/JOUR' · '6-AMPHI (A) / … –INT + EXT/JOUR'
// ★INT/EXT 표기가 이 각본에서 네 가지로 흔들린다 — 'INT/JOUR'(정상), 'lendemainEXT'(공백 없이
//   붙음), 'I-E/JOUR'(Intérieur-Extérieur 축약), 'INT& EXT/'(& 로 이어짐). 앞의 구분자(대시인지
//   슬래시인지 아무것도 없는지)와 뒤에 오는 글자를 특정하면 이런 변형을 계속 놓친다.
//   그래서 앞뒤는 안 보고, 'INT'·'EXT'·'I-E'·'E+I' 중 하나가 어딘가에 나오는지만 본다.
//   ★'\b' 단어 경계는 é 같은 프랑스어 억양 문자를 '단어 아님'으로 친다(JS \w 가 ASCII만 인식).
//   그래서 'Extérieur'의 't'와 'é' 사이를 경계로 오인해 'Ext'가 EXT로 잘못 매치됐다
//   ('1-CHALET, ... Extérieur (entrée) (C)'만으로 헤딩이 완성됐다고 오판, 뒤에 실제로 붙어야 할
//   '–INT/JOUR'를 못 이어 붙였다). 앞쪽 경계는 아예 안 본다 — 'lendemainEXT'처럼 진짜 마커가
//   앞말에 공백 없이 붙어 오는 경우도 있어서, 앞을 따지면 그런 진짜 마커를 놓친다.
//   뒤쪽만 '그 다음이 프랑스어 억양 포함 알파벳이 아니어야 한다'로 제한하면
//   Extérieur(뒤에 'érieur'가 이어짐)는 걸러지고 lendemainEXT(뒤가 '/')는 살아남는다.
const AZ = 'a-zA-Zà-ÿÀ-ÖØ-öø-ÿ'
const SCENE = new RegExp(`^\\d{1,3}[A-Za-z]?\\s*[-–—]\\s*.+(?:(?:INT|EXT)(?![${AZ}])|I[-+]E(?![${AZ}])|E[-+]I(?![${AZ}]))`, 'i')
// 영어식이 섞여 있을 수도 있으니 그것도 받는다
const SCENE_EN = /^(\d{1,3}[A-Za-z]?\.?\s+)?(INT|EXT)[.\s/]/i
const isCue = (s) => {
  const t = s.replace(/\([^)]*\)/g, '').trim()          // (OFF) · (V.O., message) 는 떼고 본다
  if (!t || t.length > 32) return false
  const L = t.replace(/[^A-Za-zÀ-ÿ]/g, ''), U = t.replace(/[^A-ZÀ-Þ]/g, '')
  return L.length >= 2 && U.length / L.length >= 0.9
}

// ★씬 헤딩이 두 줄로(가끔 세 줄로) 접혀 온다 — 장소가 길면 넘어간다.
//   '–INT/JOUR' 가 다음 줄 맨 앞으로 오는 경우('1-CHALET, Sdb Sandra+ … (C)' / '–INT/JOUR')도
//   있지만, 장소 이름이 다음 줄까지 이어지다가 그 뒤에야 INT/EXT 가 나오는 경우도 있다
//   ('41–(A) PALAIS DE JUSTICE,Salle des assises / (B) CHALET, Chambre Samuel +' /
//   'cuisine–INT/JOUR' — 둘째 줄이 'cuisine' 으로 시작해 다음줄 시작 검사에 안 걸렸다).
//   그래서 '다음 줄 시작이 INT/EXT인가'로 한 줄만 보지 않고, 씬 번호로 시작한 뒤
//   SCENE 규칙을 만족할 때까지(최대 3줄) 계속 이어붙인다.
const body = []
const kept = lines.filter(l => inCol(l, xAction) || inCol(l, xSpeech))
for (let i = 0; i < kept.length; i++) {
  const l = kept[i]
  if (inCol(l, xAction) && /^\d{1,3}[A-Za-z]?\s*[-–—]/.test(l.text) && !SCENE.test(l.text)) {
    let text = l.text, j = i, joined = 0
    while (joined < 2) {
      const nx = kept[j + 1]
      if (!nx || !inCol(nx, xAction)) break
      text += ' ' + nx.text.trim(); j++; joined++
      if (SCENE.test(text)) break
    }
    if (SCENE.test(text)) { body.push({ ...l, text }); i = j; continue }
  }
  body.push(l)
}

const out = []
let scenes = 0, cues = 0, dias = 0
for (const l of body) {
  const s = l.text
  if (inCol(l, xAction)) {
    if (SCENE.test(s) || SCENE_EN.test(s)) { scenes++; out.push('', `# ${s}`, '') }
    else out.push(s)
    continue
  }
  // ★대사 열에서 화자를 어떻게 아나: '덩어리의 첫 줄'로 잡았더니 두 번째 화자부터
  //   전부 대사로 남았다(대사 블록이 지문 없이 이어지기 때문). 이 열에서 대문자로만 된
  //   짧은 줄은 화자뿐이므로 위치를 보지 않고 그것만으로 가른다.
  if (isCue(s)) { cues++; out.push('', `@${s}`); continue }
  dias++
  out.push(`- ${s}`)
}

const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
const base = pdfName.replace(/\.pdf$/i, '')
writeFileSync(join(dir, `${base}_formatted.txt`), text)
console.error(`씬 ${scenes} · 화자 ${cues} · 대사 ${dias} → ${base}_formatted.txt`)
