import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
const CONTENT='/Users/hojun/Projects/scriptroom/content'
const SKIP=new Set(['scripts','scripts-ocr','posters-bauhaus'])
const bx=x=>Math.round(x/5)*5
const isRealCue=(s)=>{const c=s.trim(); if(c.length<2||c.length>32)return false; const L=c.replace(/[^A-Za-z]/g,''),U=c.replace(/[^A-Z]/g,''); return L.length>=2&&U.length/L.length>=0.9}
const out=[]
for(const w of readdirSync(CONTENT)){
  if(SKIP.has(w)||w.startsWith('.')) continue
  let st; try{ st=statSync(join(CONTENT,w)) }catch{continue}
  if(!st.isDirectory()) continue
  const pdf=readdirSync(join(CONTENT,w)).find(f=>f.toLowerCase().endsWith('.pdf'))
  if(!pdf) continue
  try{
    const doc=await getDocument({data:new Uint8Array(readFileSync(join(CONTENT,w,pdf))),useSystemFonts:true}).promise
    const lines=[]
    for(let p=1;p<=doc.numPages;p++){
      const tc=await (await doc.getPage(p)).getTextContent(); const byY={}
      for(const it of tc.items){ if(!it.str.trim())continue; const y=Math.round(it.transform[5]); (byY[y]=byY[y]||[]).push([it.transform[4],it.str]) }
      for(const y of Object.keys(byY)){ const r=byY[y].sort((a,b)=>a[0]-b[0]); lines.push({x:Math.round(r[0][0]),text:r.map(c=>c[1]).join('')}) }
    }
    if(lines.length<200) continue
    const freq={},cueFreq={}
    for(const l of lines){ const k=bx(l.x); freq[k]=(freq[k]||0)+1; if(isRealCue(l.text)) cueFreq[k]=(cueFreq[k]||0)+1 }
    const xsByFreq=Object.entries(freq).map(([x,n])=>[+x,n]).sort((a,b)=>b[1]-a[1])
    const cueSorted=Object.entries(cueFreq).map(([x,n])=>[+x,n]).sort((a,b)=>b[1]-a[1])
    if(!cueSorted.length||cueSorted[0][1]<5) continue
    const character=cueSorted[0][0]-20
    const leftPeaks=xsByFreq.filter(([x])=>x<character-30)
    if(!leftPeaks.length) continue
    const top3=leftPeaks.slice(0,3)
    const oldX=Math.min(...top3.map(e=>e[0]))
    const solid=leftPeaks.filter(([,n])=>n>=lines.length*0.03)
    const newX=Math.min(...(solid.length?solid:leftPeaks).slice(0,3).map(e=>e[0]))
    if(oldX!==newX){
      const noisy=top3.find(([x])=>x===oldX)
      out.push(`${w}\t옛${oldX}(${noisy?noisy[1]:'?'}줄) → 새${newX}\t${lines.length}줄`)
    }
  }catch(e){}
}
console.log(out.length?out.join('\n'):'밴드 바뀌는 작품 없음')
console.log('---총 '+out.length+'편---')
