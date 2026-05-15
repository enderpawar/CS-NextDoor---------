# Codex / Claude 분담 규칙

> **본 프로젝트는 Codex와 Claude를 병행 사용합니다.**
> 둘 다 이 저장소의 `CLAUDE.md` + `.claude/rules/`를 정본으로 따릅니다.
> 두 에이전트가 같은 코드를 동시에 건드리지 않도록 책임 영역과 인수인계 규칙을 정의합니다.

---

## 분담 가이드 (강한 권장, 절대 금지는 아님)

| 영역 | 주 담당 | 보조 |
|---|---|---|
| **Python 노트북** (`notebooks/`) | Codex | Claude |
| **OpenCV.js 이식** (`src/lib/cv/`, `src/hooks/use*`) | Claude | Codex |
| **컴포넌트 통합** (`src/components/mobile/`) | Claude | Codex |
| **Spring 백엔드** (`backend/`) | 자유 | 자유 |
| **harness 문서** (`.claude/`, `CLAUDE.md`) | Claude | (Codex는 읽기만) |
| **README** (마감 직전) | Claude | (Codex는 단락 단위 생성 가능) |
| **데이터셋 라벨링** (`data/*/ground-truth.csv`) | 사람 | — |

> 이 분담은 강제가 아니라 **혼선 방지용 디폴트**. 한쪽이 막히면 다른 쪽이 이어받아도 됨.

---

## 인수인계 (Handoff) 프로토콜

### 다른 에이전트에게 작업을 넘길 때 작성할 것

`.claude/handoff/` 디렉토리에 임시 마크다운으로 작성:

```
.claude/handoff/
├── YYYY-MM-DD-<from>-to-<to>-<short-name>.md
└── ...
```

**파일 양식**:

```markdown
# Handoff: <작업 이름>

- From: claude | codex
- To:   claude | codex
- Date: 2026-MM-DD

## 목표
한 줄.

## 현재 상태
- ✅ 완료된 것
- 🚧 진행 중인 것
- ❌ 막힌 것 (있다면 원인)

## 핵심 파일
- `path/to/file.ts:LL-LL` — 무엇이 들어있나
- `path/to/other.ipynb` — 어느 셀까지 진행됨

## 다음 작업
- [ ] 구체적 다음 단계 1
- [ ] 구체적 다음 단계 2

## 주의사항
- 함정/제약 (예: OpenCV.js Mat 메모리, isSendingRef 충돌)

## 검증 방법
- `npm run test:cv` 통과 / 노트북 셀 N까지 실행 가능 / `.png` 산출 확인
```

### 인수인계가 끝나면

- 받은 쪽이 작업 시작 시 handoff 파일에 `## 인수 ✅ <date>` 한 줄 추가
- 작업 완료 시 handoff 파일 삭제 또는 `.claude/handoff/archive/`로 이동

---

## 동시 편집 회피 규칙

### 같은 파일을 동시에 만지지 않는다
- 사람이 활성 에이전트를 한 번에 하나만 진행
- 또는 다른 파일/모듈만 만지도록 작업 분배

### 충돌이 의심되면
1. `git status`로 변경 사항 확인
2. 두 에이전트의 변경이 같은 파일이면 **사람이 머지**
3. 가능하면 모듈/파일 단위로 분리해서 다음부터 분담

---

## 두 에이전트 모두 따라야 할 것

### 1. 컨벤션 일치
- `.claude/rules/coding-conventions.md`
- `.claude/rules/cv-workflow.md` (Python ↔ OpenCV.js 매핑)
- `.claude/rules/cv-modules.md` (모듈 구조)

### 2. 우선순위 일치
- Phase 6, 7, 7-B 완성 = 최우선
- 모듈 1, 2, 3 = 필수
- Phase 9, 10, 11 = 후순위 (README에 Future Work)

### 3. README 양식 일치
- `.claude/rules/evaluation-metrics.md` 양식 사용
- 새 모듈 추가 시 README에 인용 + 표 + 그래프 모두

### 4. 카피 감점 회피
- 모든 OpenCV 함수 / 라이브러리 / 튜토리얼 출처를 README References에 기록
- 노트북 셀 첫 줄 주석에도 핵심 출처 명시

### 5. 메모리 관리
- OpenCV.js Mat은 `try/finally + .delete()`
- `useRef`로 보관 시 cleanup에서 해제

### 6. 사용자 결정 사항 존중
- **딥러닝 학습 절대 금지** (Tesseract.js inference는 허용 — 사전 학습 모델)
- 클래식 OpenCV로만 깊이 어필
- Phase 9~11 구현 안 함 (Future Work)

---

## Codex가 알아둘 것 (Claude와 차이)

- Codex는 이 저장소의 `CLAUDE.md`를 따로 읽지 않을 수 있음 → **작업 시작 전 사용자가 명시적으로 다음 파일을 컨텍스트로 제공**:
  - `CLAUDE.md`
  - `.claude/rules/cv-modules.md`
  - `.claude/rules/cv-workflow.md`
  - `.claude/rules/evaluation-metrics.md`
  - 작업 대상 노트북의 `notebooks/NN-*.md` 가이드
- Codex 출력 코드도 본 저장소 `coding-conventions.md` 따라야 함 (`export default`, `useRef + cleanup` 등)
- Codex가 작성한 노트북도 위 evaluation-metrics 양식 PNG/CSV를 `docs/`에 저장

---

## 메모리 / 컨텍스트

- Claude의 auto-memory는 `~/.claude/.../memory/`에 위치 (사용자 환경)
- 이 메모리는 Claude만 읽음 → Codex와 공유할 결정사항은 **반드시 `.claude/rules/` 또는 `CLAUDE.md`에 기록**

---

## 작업 사이클 예시

1. **사용자**: "모듈 1 노트북 만들어줘" → Codex 호출
   - Codex가 `notebooks/01-bios-pipeline.ipynb` 작성 + `docs/ablation-results/*.csv` 산출
   - 완료 시 `.claude/handoff/2026-05-17-codex-to-claude-module1-port.md` 작성

2. **사용자**: "이제 OpenCV.js로 이식해줘" → Claude 호출
   - Claude가 handoff 파일 읽고 `src/lib/cv/biosPipeline.ts` 작성
   - 통합 컴포넌트 수정
   - 테스트 추가
   - 완료 시 handoff 파일 archive

3. **사용자**: 본인이 데이터셋 라벨링 (`data/bios/ground-truth.csv`)

이 사이클을 모듈 1, 2, 3에 대해 반복.
