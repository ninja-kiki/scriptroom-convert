#!/usr/bin/env python3
"""부기 나이츠 정답지 대조 — OCR 추출본이 원래 각본과 얼마나 같은지 단어 단위로 잰다.
   깨끗한 RTF(정답)와 스캔 PDF 추출본(문제)을 정렬해 일치율을 낸다."""
import re, subprocess, difflib, sys, json

CLEAN_RTF = '/Users/hojun/Projects/scriptroom/content/boogie-nights/Boogie Nights.rtf'
OCR_TXT   = sys.argv[1] if len(sys.argv) > 1 else '/tmp/bn_ocr.txt'

clean = subprocess.run(['textutil','-convert','txt','-stdout',CLEAN_RTF],
                       capture_output=True, text=True).stdout
ocr = open(OCR_TXT, encoding='utf-8').read()

def words(t):
    t = re.sub(r'(?m)^[-@#]\s*', ' ', t)          # 구조 마커 제거
    t = t.replace('’', "'").replace('‘', "'")
    return re.findall(r"[A-Za-z][A-Za-z']*|\d+", t)

A, B = words(clean), words(ocr)
low = lambda xs: [w.lower() for w in xs]
sm = difflib.SequenceMatcher(None, low(A), low(B), autojunk=False)

same = 0
diffs = []
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == 'equal':
        same += i2 - i1
    else:
        diffs.append((tag, A[i1:i2], B[j1:j2]))

print(f"정답지 {len(A):,}단어 · 추출본 {len(B):,}단어")
print(f"일치 {same:,} → 정확도 {same/max(len(A),1)*100:.2f}%")

# 어긋난 구간을 유형별로 분류
subs = [(a, b) for tag, a, b in diffs if tag == 'replace' and len(a) == len(b) == 1]
dele = [a for tag, a, b in diffs if tag == 'delete']
ins  = [b for tag, a, b in diffs if tag == 'insert']
print(f"\n어긋난 구간 {len(diffs):,}곳")
print(f"  1:1 단어 치환 {len(subs):,}  (OCR 오인식 후보)")
print(f"  정답에만 있음 {sum(len(x) for x in dele):,}단어  (추출이 놓침)")
print(f"  추출에만 있음 {sum(len(x) for x in ins):,}단어  (OCR이 만들어냄)")

print("\n오인식 표본 (정답 → 추출):")
for a, b in subs[:25]:
    print(f"    {a[0]:<22} → {b[0]}")

json.dump({'sub': [[a[0], b[0]] for a, b in subs]}, open('/tmp/bn_subs.json','w'))
