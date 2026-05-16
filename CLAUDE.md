# 옆집 컴공생 (NextDoor CS)

> "수리기사 부르기 전, 옆집 컴공생에게 먼저 물어보세요!"
> **Mobile PWA** = 하드웨어 시각/청각 진단 | **Desktop Electron** = 소프트웨어 시스템 진단

@.claude/rules/glossary.md
@.claude/rules/coding-conventions.md
@.claude/rules/implementation-checklist.md
@.claude/rules/workflow.md
@.claude/rules/api-endpoints.md
@.claude/rules/figma-design-system.md
@.claude/rules/cv-modules.md
@.claude/rules/cv-workflow.md
@.claude/rules/evaluation-metrics.md
@.claude/rules/codex-claude-handoff.md

## 규칙 우선순위

충돌 시 아래 순서로 상위 문서가 이깁니다:

1. **`CLAUDE.md`** — 프로젝트 정의 (최상위)
2. **`.claude/rules/`** — 도메인별 규칙 (자동 로드)
3. **`docs/snippets.md`** — 구현 레퍼런스 (on-demand)
4. **`reference/`** — 배경 자료 (on-demand): `design-system.md` (Figma 원본 분석), `Market_report.md` (시장 조사)

> 하위 문서에 상위와 다른 내용이 있으면 상위가 정본입니다. 하위 문서는 상위의 요약·예시일 뿐이며 독립 소스가 아닙니다.

---

## 🎯 컴퓨터 비전 과목 텀프로젝트 — 30점 만점 전략

본 저장소는 **CV 과목 텀프로젝트 (마감 2026-06-07)** 입니다.
평가축: 아이디어/창의성 + 완성도 + **CV 알고리즘 깊이** (상대평가, 30점).

### 사용자 결정 사항 (변경 금지)
- ❌ **딥러닝 학습 절대 금지** — 시간 부족 + 학습 경험 부족
- ✅ **클래식 OpenCV 알고리즘으로 CV 깊이 어필**
- ✅ **Tesseract.js inference는 허용** (사전 학습 모델, finetune 없음)
- ✅ **Codex + Claude 병행 작업** (`codex-claude-handoff.md` 분담 규칙)

### 전략 요약
1. **Python(Jupyter)으로 알고리즘 검증 → OpenCV.js로 이식** — `cv-workflow.md`
2. **클래식 CV 모듈 3개 + 정량 ablation** — `cv-modules.md`
3. **README 품질이 점수의 60%** — `evaluation-metrics.md`
4. **Phase 9~11은 후순위 (Future Work로 README 명시)** — `implementation-checklist.md`

### 핵심 CV 모듈 (필수)
| 우선순위 | 모듈 | 통합 위치 |
|---|---|---|
| 🥇 P0 | 모듈 1 — BIOS 화면 End-to-End 파이프라인 (Hough + Homography + CLAHE + Threshold + OCR) | Phase 7-B |
| 🥈 P1 | 모듈 2 — 라이브 프레임 변화 감지 정량 분석 (4×3×3 매트릭스) | Phase 7-B |
| 🥉 P2 | 모듈 3 — 프레임 품질 사전 필터 (Laplacian/Optical Flow) | Phase 7-B |

선택: 모듈 4 (비프음 스펙트로그램, Phase 8) / 5 (카메라 캘리브레이션) / 6 (Hough Circle 커패시터) / 7 (이미지 스티칭).

---

## 진단 모드 분리

| 구분 | Mobile (PWA) | Desktop (Electron) |
|---|---|---|
| **배포** | 브라우저 PWA | Electron 앱 (.exe / .dmg) |
| **진단 대상** | **하드웨어** 물리적 문제 | **소프트웨어** 시스템 문제 |
| **입력** | 카메라 + 마이크 | OS 시스템 데이터 자동 수집 + 증상 텍스트 + 클립보드 이미지 붙여넣기 |
| **진단 예시** | 커패시터 불량, 비프음, LED 패턴 | CPU 과부하, 메모리 누수, BSOD 이력 |
| **핵심 기술** | OpenCV.js + MediaRecorder + Gemini Vision | systeminformation + Event Log + Gemini |

> PWA는 항상 앱 시작 시 세션을 자동 생성합니다 (`SessionType.PWA_ONLY`). Electron QR 스캔 시 해당 세션을 폐기하고 Electron 세션에 합류(`SessionType.LINKED`)합니다. 독립 진단(SW 데이터 없음)과 연결 진단 모두 세션 ID로 추적됩니다.

---

## Tech Stack

| Layer | Mobile PWA | Desktop Electron |
|---|---|---|
| Shell | React PWA (manifest + SW) | Electron 28+ (Node.js 20) |
| **언어** | **TypeScript (`.ts` / `.tsx`)** | **TypeScript (`.ts`) — main/preload 포함** |
| 하드웨어 입력 | `getUserMedia` (카메라/마이크) | — |
| 시스템 수집 | — | `systeminformation` + `child_process` |
| 이미지 처리 | OpenCV.js (WASM) | — |
| AI 분석 | Gemini 3.1 Pro | Gemini 3.1 Pro |
| 백엔드/DB | Spring Boot 3.x + Spring AI + PostgreSQL (공유) | ← |
| 세션 연결 | WebSocket STOMP (공유) | ← |

---

## Project Structure

```
nextdoor-cs/
├── electron/main.ts, preload.ts
│   └── modules/ systemMonitor.ts, processAnalyzer.ts, eventLogReader.ts, diskHealth.ts
├── pwa/public/ manifest.json, sw.js        ← sw.js는 Service Worker — TS 빌드 대상 제외
├── src/
│   ├── types/                              ← 공유 타입 정의 (IPC, API 응답, 진단 도메인)
│   │   └── index.ts
│   ├── lib/cv/                             ← CV 알고리즘 모듈 (OpenCV.js 이식 결과)
│   │   ├── frameMetrics.ts                 (기존, 모듈 3 기반)
│   │   ├── biosPipeline.ts                 (모듈 1)
│   │   ├── changeDetection.ts              (모듈 2)
│   │   └── beepClassifier.ts               (모듈 4, 선택)
│   ├── components/
│   │   ├── desktop/  SystemDashboard.tsx, ProcessList.tsx, EventLogViewer.tsx, DiskHealthCard.tsx
│   │   │             HypothesisTracker.tsx, PatternSelector.tsx
│   │   ├── mobile/   CameraView.tsx, VideoAnalysis.tsx, AudioCapture.tsx
│   │   │             BiosTypeSelector.tsx, ShootingGuide.tsx
│   │   │             LiveGuideMode.tsx, GuideContextSelector.tsx, GuideBubble.tsx
│   │   └── shared/   DiagnosisResult.tsx, DiagnosisConfidence.tsx, SessionManager.tsx
│   ├── hooks/ useRuntimeMode.ts, useSystemInfo.ts, useOpenCV.ts, useFpsMonitor.ts
│   │          useReproductionMonitor.ts, usePostDiagnosis.ts
│   │          useLiveFrameCapture.ts, useGeminiLiveGuide.ts
│   │          useBiosPipeline.ts (모듈 1)
│   └── api/diagnosisApi.ts
├── notebooks/                              ← Python(Jupyter) CV 실험 — README/이식의 원천
│   ├── 01-bios-pipeline.{md,ipynb}         (모듈 1)
│   ├── 02-histogram-analysis.{md,ipynb}    (모듈 2)
│   ├── 03-frame-quality.{md,ipynb}         (모듈 3)
│   ├── 04-beep-spectrogram.{md,ipynb}      (모듈 4, 선택)
│   └── requirements.txt
├── data/                                   ← 테스트 데이터셋 (.gitignore로 바이너리 제외)
│   ├── bios/{ami,award,phoenix,other}/     + ground-truth.csv
│   ├── motherboard/                        + ground-truth.csv
│   ├── beep/<pattern>/                     + ground-truth.csv
│   └── live-frames/<scenario>/             + ground-truth.csv
├── docs/
│   ├── architecture.md                     ← mermaid 다이어그램 (README 임베드)
│   ├── cv-pipeline/                        ← 알고리즘 단계별 시각 갤러리 PNG
│   ├── ablation-results/                   ← 정량 평가 결과 CSV/PNG
│   ├── cv-harness.md                       (기존)
│   └── snippets.md                         (기존)
├── .claude/handoff/                        ← Codex ↔ Claude 인수인계 메모
└── backend/src/main/java/com/nextdoorcs/
    ├── controller/ DiagnosisController, SessionController, GuideController
    ├── service/    DiagnosisService, GeminiService, LiveGuideService
    ├── agent/      RepairAgent
    ├── mcp/        ManualToolProvider
    └── entity/     DiagnosisHistory, SolutionKnowledge, DiagnosisSession
```

---

## Phase Roadmap

| Phase | 환경 | 목표 | 핵심 파일 |
|---|---|---|---|
| **1** | 공통 | Gemini API 기반 + API 쿼터 설계 | `GeminiService.java`, `DiagnosisController.java` |
| **2** | Electron | 앱 셋업 + IPC 브리지 | `main.ts`, `preload.ts`, `useRuntimeMode.ts` |
| **3** | Electron | 시스템 모니터 (CPU/GPU/메모리/온도) | `systemMonitor.ts`, `SystemDashboard.tsx` |
| **4** | Electron | 프로세스 + 이벤트 로그 분석 | `processAnalyzer.ts`, `eventLogReader.ts` |
| **5** | Electron | SW 진단 풀 플로우 (가설 추적·재현·패턴·신뢰도) | `HypothesisTracker.tsx`, `ReproductionMode.tsx`, `PatternSelector.tsx`, `DiagnosisConfidence.tsx` |
| **6** ⭐ | PWA | PWA 셋업 + 독립 모드 + 오프라인 폴백 | `manifest.json`, `sw.js`, `CameraView.tsx` |
| **7** ⭐ | PWA | OpenCV 오버레이 + 영상 분석 + 촬영 가이드 | `useOpenCV.ts`, `VideoAnalysis.tsx`, `ShootingGuide.tsx` |
| **7-B** ⭐⭐ | PWA | 라이브 카메라 가이드 모드 + **모듈 1/2/3 통합** | `LiveGuideMode.tsx`, `biosPipeline.ts`, `useLiveFrameCapture.ts`, `useGeminiLiveGuide.ts`, `GuideController.java` |
| **8** | PWA | BIOS 자동 감지 + 오디오 진단 (+모듈 4 선택) | `BiosTypeSelector.tsx`, `AudioCapture.tsx` |
| **9** 🔽 | 공통 | (CV 무관 — Future Work) MCP 매뉴얼 툴 연동 | `ManualToolProvider.java`, `RepairAgent.java` |
| **10** 🔽 | 공통 | (CV 무관 — Future Work) DB 이력 + 지식베이스 + 사후 확인 | `DiagnosisHistory.java`, `SolutionKnowledge.java`, `usePostDiagnosis.ts` |
| **11** 🔽 | 공통 | (CV 무관 — Future Work) 크로스 플랫폼 세션 (QR·연장·수동 입력·인증) | `SessionController.java`, `QRDisplay.tsx`, `SessionManager.tsx` |

> ⭐ = CV 텀프로젝트 평가 핵심. ⭐⭐ = 메인 쇼케이스. 🔽 = 마감 후 또는 시간 여유 시.

---

## Phase 진행 상태

> Phase 완료 시 상태를 업데이트합니다. 새 세션에서 이 표로 재개 지점을 판단합니다.

| Phase | 상태 |
|---|---|
| **0** (인프라) | ✅ 완료 — 타입·디자인 토큰·빌드 설정·스타일 CSS 완비 |
| **1** | ✅ 완료 — Gemini REST API 직접 호출, IP 기반 일일 쿼터, /hardware + /hypotheses 엔드포인트 검증 완료 |
| **2** | ✅ 완료 — main.ts + preload.ts IPC 브리지, useRuntimeMode, App.tsx 클립보드 이미지 붙여넣기 완비 |
| **3** | ✅ 완료 — CPU 온도·사용률·메모리·GPU(한계 명시)·디스크 I/O 실시간 수집 + SystemDashboard 렌더링 |
| **4** | ✅ 완료 — processAnalyzer + eventLogReader 수집, ProcessList(CPU/메모리 정렬 토글) + EventLogViewer(에러/경고) 렌더링 |
| **5** | ✅ 완료 — 3단계 UI(증상입력→가설추적→재현모드) + 줌 전환 애니메이션 + 풀스크린 채팅뷰 + HypothesisTracker(해결됐나요 분기 포함) + 재현 모드(베이스라인 저장·delta 계산·결과 해석) + DiagnosisConfidence(< 0.6 배너) + 베이스라인 이상 감지 + 완료 화면 + 복합 원인 버튼. PatternSelector·HW 에스컬레이션은 Phase 11로 이관. 백엔드 엔드포인트 미구현(USE_MOCK=true). 테스트 54개 |
| **6** ⭐ | ✅ 완료 — manifest.json·sw.js·PwaPage.tsx·mobile.css·App.tsx 연결 완비 |
| **7** ⭐ | ✅ 완료 — useOpenCV.ts·ShootingGuide.tsx·CameraView 통합(LiveGuideMode 내부) 완성 |
| **7-B** ⭐⭐ | ✅ MVP 완료 — LiveGuideMode.tsx·useGeminiLiveGuide.ts·useLiveFrameCapture.ts·모듈1/2/3 통합 완료. Python 노트북 01~03 synthetic sanity ablation 실행 및 BEST_PARAMS/품질 임계값 반영. 실제 촬영 데이터 기반 재튜닝은 제출 전 권장 |
| **8** | ✅ 완료 — BiosTypeSelector.tsx·AudioCapture.tsx·PwaPage 통합. MediaRecorder iOS mp4 폴백·AEC 비활성화 적용. 모듈 4(비프음 스펙트로그램) Future Work |
| **9** 🔽 | 🚫 마감 후로 미룸 — Future Work (CV 무관) |
| **10** 🔽 | 🚫 마감 후로 미룸 — Future Work (CV 무관) |
| **11** 🔽 | 🚫 마감 후로 미룸 — Future Work (CV 무관) |
| **CV 모듈 1** (BIOS 파이프라인) | ✅ MVP 완료 — `src/lib/cv/biosPipeline.ts` OpenCV.js 이식 완성. `notebooks/01-bios-pipeline.ipynb` synthetic 입력으로 실행 검증 완료. OCR 정확도 수치는 로컬 Tesseract 설치 후 실제 데이터로 재측정 필요 |
| **CV 모듈 2** (히스토그램 분석) | ✅ MVP 완료 — `src/lib/cv/changeDetection.ts` 4 메트릭 이식 완성. `notebooks/02-histogram-analysis.ipynb` synthetic 5시나리오 ablation 결과: CORREL+GRAY+window=5+threshold=0.9999 |
| **CV 모듈 3** (프레임 품질) | ✅ MVP 완료 — `src/lib/cv/frameMetrics.ts` Laplacian variance + 밝기 통계 완성. `notebooks/03-frame-quality.ipynb` Commons 웹 이미지 ablation 결과: minSharpness=0.05, minBrightness=0.15, maxBrightness=0.85 |
| **CV 모듈 4** (비프음, 선택) | 🔲 미시작 — `notebooks/04-beep-spectrogram.ipynb` |

---

## Build & Run

```bash
cd backend && ./mvnw spring-boot:run   # 백엔드
npm run electron:dev                    # Electron 개발
npm run pwa:dev                         # PWA 개발 — http://localhost:3000
npm run electron:build                  # → dist/*.exe / *.dmg
npm run pwa:build                       # HTTPS 필수
git push origin main                    # Render 자동 배포
# 환경변수: GEMINI_API_KEY, SPRING_DATASOURCE_URL (Supabase), ALLOWED_ORIGINS

# CV 노트북 환경
cd notebooks
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
jupyter lab
```

> Phase별 상세 검증: `/implement-phase <번호>`
> CV 모듈 작업 흐름: `.claude/rules/cv-workflow.md`

---

## Agent Persona

```
당신은 '옆집 컴공생' AI입니다.
- 말투: 친근한 공대생처럼 (하지만 존댓말 사용.)
- 전문 용어는 괄호로 설명
- 답변 형식: "[부품/프로세스]에 문제 있어요. 해결방법: ~~" + 반드시 "확신도: 약 N%" 포함
- 가설 우선순위: 직접 시도 가능·위험도 낮은 것 → A, 전문 개입 필요 → C
- 복합 원인 시 "SW + HW 복합 원인 가능성 있음" 명시
- 수리기사 권장: 납땜·전문장비·안전위험·신뢰도 60% 미만 중 하나라도 해당 시
```

---

## Critical Notes

- **AI 모델**: `gemini-3.1-pro-preview` — 목록에 없으면 `gemini-2.0-flash` 대체
- **Electron 보안**: `contextIsolation: true`, `nodeIntegration: false` 필수
- **PWA HTTPS**: `getUserMedia` + SW는 HTTPS 필수 (localhost 제외)
- **GeminiService.extractText()**: null 방어 없음 → API 오류 시 NPE. Phase 1에서 반드시 추가
- **JSONB vs TEXT**: Phase 1 설계 시 확정 필수. 변경 시 DB 마이그레이션 → TEXT 권장
- **OpenCV Mat**: `try/finally`로 `.delete()` 보장 — JS GC는 WASM 힙 미회수
- **IPC 리스너**: Strict Mode useEffect 2회 실행 → `removeAllListeners()` 선행 후 `on()`
- **BIOS 자동 감지**: `systeminformation.bios().vendor` → 세션 저장 → PWA 자동 수신. 실패 시 수동 선택
- **세션 인증**: sessionId + authToken QR 인코딩 필수. 토큰 1회 사용 후 폐기
- **세션 연장**: 만료 1분 전 경고 → extend API (+5분, 1회). 실패 시 6자리 수동 입력
- **신뢰도 60% 기준**: confidence < 0.6 → 수리기사 권장 배너 자동 표시
- **API 쿼터**: IP 기반 일일 진단 횟수 제한 미설정 시 비용 폭증 위험
- **데이터 프라이버시**: 진단 전 Gemini 서버 전송 동의 고지 UI 필수
- **Live Guide — OpenCV 역할 제한**: 히스토그램 변화 감지(`compareHist`) + CLAHE 전처리만 담당. BIOS 텍스트 OCR은 Gemini Vision에 위임 (별도 OCR 파이프라인 구축 불필요)
- **Live Guide — 비용 제어**: 히스토그램 유사도 임계값 0.92 + 최소 전송 간격 2초 + 대화 히스토리 최대 6턴. 세션 최대 수명 15분.
- **Live Guide — SSE**: `SseEmitter` 타임아웃 60초. Gemini 응답에 `[완료]` 태그 포함 시 세션 자동 종료. EventSource는 GET만 지원 → fetch() 스트리밍으로 POST 본문 전송.
- **Live Guide — 동시 전송 방지**: `isSendingRef`로 이전 응답 완료 전 새 프레임 전송 차단. 완료 전 변화 감지는 무시.
- **CV 텀프로젝트 — 딥러닝 금지**: 사용자 결정. 클래식 OpenCV + Tesseract.js inference만. 모델 학습/finetune 절대 금지.
- **CV 작업 흐름**: Python(Jupyter) 검증 → OpenCV.js 이식 (`cv-workflow.md`). README 그래프는 Python에서 생성.
- **CV 모듈 통합 위치**: 모듈 1/2/3 모두 Phase 7-B `LiveGuideMode.tsx`에서 호출 (Gemini 호출 직전 전처리 게이트).
- **OpenCV.js 출력 인자**: Python `dst = cv2.foo(src)` ≠ OpenCV.js `cv.foo(src, dst)`. 매번 출력 Mat을 별도 생성 + try/finally `.delete()`.
- **데이터 라이선스**: YouTube BIOS 화면 캡처 사용 시 README References에 URL + 채널명 명시 (카피 감점 -30점 회피).
- **Codex/Claude 분담**: Python 노트북은 Codex 우선, OpenCV.js 이식·컴포넌트 통합은 Claude 우선. 인수인계는 `.claude/handoff/` 사용.
