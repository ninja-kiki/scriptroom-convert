# scriptroom convert (로컬)

영화 각본 PDF + 자막을 받아 **포맷 → 한국어 번역**으로 변환하는 로컬 도구.
번역은 **Claude Max/Pro 구독**(`claude` CLI)으로 돌아갑니다. **API 키 불필요, 토큰 종량제 과금 없음.**

---

## 1. 미리 준비 (한 번만)

1. **Node.js** 설치 — https://nodejs.org (LTS)
2. **Claude Code CLI** 설치 + 본인 계정 로그인
   - 설치: https://claude.com/claude-code
   - 터미널에서 `claude` 실행 → 로그인 (Max 또는 Pro 구독 계정)
   - ✅ 이게 핵심입니다. 로그인이 안 돼 있으면 번역이 안 돌아갑니다.
   - 번역은 **본인 구독 사용량**을 씁니다 (각자 자기 계정).

> 확인: 터미널에서 `claude --version` 이 버전을 출력하면 OK.

---

## 2. 실행

폴더 안에서:

```bash
./launch.sh
```

- 처음 실행 시 자동으로 `npm install` (의존성 설치, 1~2분)
- 로컬 서버 + 화면이 뜨고 브라우저가 **http://localhost:5173** 으로 자동으로 열립니다
- 종료: 터미널에서 `Ctrl + C`

`launch.sh` 가 안 되면 수동으로:

```bash
npm install      # 처음 한 번
npm start        # 서버 + 화면 (http://localhost:5173)
```

---

## 3. 쓰는 법

1. **변환 탭** — 각본(PDF·TXT·RTF·FDX·Fountain) + 자막(SMI·SRT, 선택)을 드롭
2. 씬 구조 확인 후 **변환 시작** → 포맷 + 번역 진행
3. 완료되면 **formatted.txt / translated.txt** 다운로드
4. 번역본은 리더(scriptroom)로 가져가 읽기/검수

- 설정(우상단)에서 **번역 모델 / 동시 처리 수 / 라이트·다크 / 지침** 조정
- 일부 씬이 실패하면 해당 행의 **↻(재시도)** 또는 **실패 전체 재시도**

---

## 참고

- **요금**: 본인 Claude 구독 사용량만 소모. 별도 API 키·결제 없음.
- 번역 지침/용어는 `prompts.json` 에 들어 있어 그대로 공유됩니다.
- 큰 각본은 시간이 좀 걸립니다 (씬 수에 비례). 탭 여러 개로 동시에 여러 편 돌려도 됩니다.
