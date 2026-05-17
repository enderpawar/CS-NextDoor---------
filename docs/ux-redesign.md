# PWA UX 리뉴얼 방향 — Camera-First 진단 워크플로우

> **작성일**: 2026-05-16
> **상태**: 방향 확정 / 구현 착수 전
> **결정자**: 사용자 + Claude
> **마감**: 2026-06-07 (CV 텀프로젝트 제출)

---

## 0. 문서 목적

본 문서는 **PWA를 메인으로, Electron을 보조로 재포지셔닝하면서** PWA의 진단 워크플로우를 Camera-First 패러다임으로 전면 개편하는 방향을 정의합니다.

이 문서가 정본이 되며, `.claude/rules/workflow.md` 및 `.claude/rules/figma-design-system.md` 의 PWA 관련 흐름은 본 문서의 결정에 따라 추후 갱신됩니다 (CLAUDE.md 우선순위 원칙에 따라 본 문서가 상위 결정).

---

## 1. 결정 배경

### 1-1. 정체성 재정렬

기존 컨셉:
> "옆집 컴공생" = HW 진단(PWA) + SW 진단(Electron) **두 모드 평행**

문제: CV 텀프로젝트 평가축에서 SW 진단(Electron)은 가점이 작은데, 평행 배치로 인해 메인 메시지가 흐릿해짐. PC 부팅이 안 되는 상황을 위한 PWA 가치가 부각되지 않음.

새 컨셉:
> "옆집 컴공생" = **카메라 한 번이면 부팅 안 되는 PC도 진단** (PWA + 클래식 OpenCV가 본체)
> Electron은 "부팅 가능한 PC를 위한 보조 흐름" — 코드는 동결, README 후반부 1섹션으로 강등

### 1-2. CV 코드 분포 검증

- `src/lib/cv/` 전체 (biosPipeline·changeDetection·frameMetrics) → **PWA 전용**
- `src/hooks/use{OpenCV,BiosPipeline,LiveFrameCapture,GeminiLiveGuide}` → **PWA 전용**
- `src/components/mobile/` 전체 → **PWA 전용**
- `electron/` 안 OpenCV 참조 0개

→ 컨셉 재정렬은 이미 코드 구조와 일치. 추가 코드 이동 없이 **문서·메시지·UI 동선만 변경**하면 됨.

---

## 2. 현재 PWA 워크플로우 매핑

```
[App.tsx]                       mode 분기 (electron / pwa-session / pwa-standalone)
    ↓ isStandalone=true
[PwaPage 'home']               ← 진입 후 첫 화면
    ┝ 헤더 (옆 로고 + "옆집 컴공생" + "PC 하드웨어 진단 도우미")
    ┝ 독립 모드 경고 배너
    ┝ 카드 1: 라이브 카메라 가이드 (📷)   ← CV 메인 쇼케이스
    ┝ 카드 2: 비프음 진단 (🔊)            ← 보조
    └ HTTPS 안내 푸터
        ↓ "라이브 카메라 가이드" 탭
[LiveGuideMode page='select']
    └ GuideContextSelector (5종 그리드)
        ↓ 컨텍스트 선택
[LiveGuideMode page='guide-intro']
    └ ShootingGuide (5단계 텍스트 + 4 칩 + "이해했어요" 버튼)
        ↓
[LiveGuideMode page='camera']
    ┝ 상단바 (라이브 가이드 + 배지 + 종료)
    ┝ 카메라 16:9 + 숨김 canvas
    ┝ 품질 피드백 줄
    └ GuideBubble (캡처/분석 상태 + AI 텍스트 + stale 경고)
        ↓ Gemini "[완료]" or 종료
[LiveGuideMode page='done']
    └ "✅ 가이드가 완료됐어요" + 처음으로 버튼
```

**진입 마찰**: 카메라 시작까지 **4번 화면 전환 / 5번 의사결정**. 비프음 진단은 별도 평행 흐름.

---

## 3. 핵심 문제점

### 🔴 P0 — 정체성·정보위계 (점수 직격)

| ID | 문제 | 평가 영향 |
|---|---|---|
| **P0-1** | 메인 쇼케이스가 평범한 카드로 격하 — 라이브 가이드와 비프음이 동일 비중 두 카드로 평행 배치 | 평가자 첫 인상에서 핵심 가치 인식 실패 |
| **P0-2** | **CV 작동의 "보이지 않음"** — `canvas {display:none}`, OpenCV가 매 프레임 Hough/Homography/CLAHE/Threshold/OCR을 돌려도 화면엔 일반 카메라 + 텍스트만 보임 | 평가자가 "그냥 사진 찍어 Gemini에 보내는 앱"으로 오해 → CV depth 어필 실패가 30점 평가축 직격 |
| **P0-3** | 진단 도달까지 마찰 과다 (홈→컨텍스트→촬영가이드→카메라 = 4 step) | demo 영상 첫 30초가 클릭 시연으로 낭비 |

### 🟡 P1 — 인지부하·인체공학

| ID | 문제 |
|---|---|
| **P1-1** | GuideContext 5종(BIOS진입/부팅메뉴/Win설치/BIOS초기화/SecureBoot)은 사용자가 자기 문제를 분류하기 어려운 기술 카테고리 → 선택 마비 |
| **P1-2** | ShootingGuide 풀스크린 인터럽션 — 5줄 텍스트를 읽고 잊혀짐. 정작 코칭이 필요한 시점은 카메라 켜진 후 |
| **P1-3** | 한손 thumb zone 무시 — 종료/액션 버튼이 모두 화면 상단·중앙. 하단 1/3 (Action zone) 비어있음 |
| **P1-4** | 카메라 화면 정보 과밀 — 동시 표시 가능 요소 최대 6개 레이어 (상단바·품질·캡처배지·분석타이머·AI 버블·stale 경고) |

### 🟢 P2 — 흐름·연속성

| ID | 문제 |
|---|---|
| **P2-1** | 비프음 진단 격리 — 라이브 가이드 중 "비프음도 들리는데..." 시나리오에서 다시 홈으로 돌아가야 함 |
| **P2-2** | BiosTypeSelector 중복 작업 — 카메라가 이미 본 vendor 정보(OCR로 추출 가능)를 사용자에게 다시 묻는 셈 |
| **P2-3** | done 화면 막다른 골목 — "✅ 완료 + 처음으로" 만. 진단 이력·다음 추천 액션·결과 공유·사후 확인 없음 |
| **P2-4** | 시스템 상태(OpenCV/카메라/네트워크/Gemini) 늦은 노출 — 진단 시도 후에야 알 수 있음 |

---

## 4. 적용할 디자인 원칙

| 원칙 | 출처 패러다임 | 본 프로젝트 적용 |
|---|---|---|
| **Camera-First** | Snapchat, Google Lens, Pinterest Lens | 앱 진입 시 즉시 카메라 뷰파인더, 부가 기능은 시트/드로어 |
| **AR Guidance Overlay** | IKEA Place, Google Maps Live View, Sephora | 카메라 위 CV 처리 결과(모서리·OCR·하이라이트) 오버레이 → CV 가시화 |
| **Bottom Sheet Progressive Disclosure** | Material Design 3, Apple Maps | 컨텍스트 선택·옵션은 풀업 시트로 카메라 가림 최소화 |
| **Thumb-Zone Action** | Steven Hoober mobile heatmap research | 프라이머리 액션은 화면 하단 1/3 |
| **Smart Defaults & Inference** | Apple Wallet, Google Pay | "BIOS 진입" 디폴트, 자동 vendor 감지로 BiosType prefill |

---

## 5. 새 정보 아키텍처

```
[App 진입]
    ↓ 즉시
[CameraScreen]  ← 메인이자 디폴트 화면
    │
    ├─ 좌상단: 작은 [×] 종료 (또는 햄버거 → 보조 메뉴)
    ├─ 우상단: [CV Insight 패널]  ← 모서리·OCR·품질 라이브 시각화 (CV 어필 핵심)
    ├─ 중앙: 카메라 뷰파인더 + AR 오버레이 (감지된 BIOS 메뉴 항목 박스)
    ├─ 하단 60% 영역:
    │    ┌─ AI 안내 버블 (현재 단계 + 다음 액션 + 진행률 ●●●○○ 3/5)
    │    └─ Thumb-zone 액션 바
    │         · 메인: "다음 단계" / "완료" (큰 pill 버튼)
    │         · 보조: 마이크 (비프음 동시 진단) / 도움말
    └─ 풀업 시트(선택적):
         · "어떤 작업이에요?" 컨텍스트 5종 (디폴트 자동 추론)
         · "이 화면이 아닌가요?" → 다른 작업 보기
         · 진단 이력 / 비프음 별도 진단

[권한 거부 / 카메라 불가]
    ↓ 폴백
[Manual Mode]
    └ "사진 업로드" + "비프음만 진단" + "도움말"
```

### 단일 화면 와이어프레임

```
┌────────────────────────────────────────────┐
│ ←        [BIOS 진입 안내]    🔬 CV ON      │ ← 좌:종료, 중:현재 컨텍스트, 우:CV 뱃지
│                                            │
│           ┌─────────────────┐              │
│           │  CV INSIGHT     │              │
│           │  ━━━━━━━━━━━━━  │              │
│           │  📐 모서리 4/4  │   카메라      │
│           │  📝 OCR: "Bo..."│   뷰파인더    │ ← 우상단 CV 패널 (탭으로 펼침)
│           │  ⚡ 품질 0.87   │   + AR 오버레이│
│           │  🎯 변화 감지   │   (감지된 메뉴
│           └─────────────────┘    항목 하이라이트
│                                            │
│                                            │
│                                            │
│  ┌────────────────────────────────────┐    │
│  │ AI 안내                             │    │
│  │ "Boot 탭으로 이동하세요. 방향키 →"  │   │
│  │ ●●●○○  3/5 단계                     │    │ ← 진행률 표시
│  └────────────────────────────────────┘    │
│                                            │
│   [🎙 비프음]   [✓ 다음 단계]   [? 도움]   │ ← Thumb zone (하단)
└────────────────────────────────────────────┘
   ↑ 풀업 시트 (스와이프업으로 컨텍스트 변경)
```

---

## 6. 변경 인터랙션 매핑

| 영역 | Before | After |
|---|---|---|
| **앱 진입** | 홈 카드 2개 → 가이드 카드 탭 → 컨텍스트 선택 → 촬영가이드 → 카메라 | **앱 진입 즉시 카메라 켜짐**. 컨텍스트 디폴트 "BIOS 진입", 시트 스와이프로 변경 |
| **컨텍스트 선택** | 5종 그리드 풀스크린 | 풀업 시트 + 자동 추론(모듈 1 OCR vendor 키워드) |
| **촬영 가이드** | 별도 풀스크린 + 5단계 텍스트 | 카메라 위 토스트/오버레이 코칭 ("💡 30cm 떨어지세요") + 첫 사용 1회만 풀스크린 온보딩 |
| **CV 가시화** | 숨김 canvas | **우상단 CV Insight 패널** (모서리·OCR·품질·변화감지 라이브) + AR 박스 오버레이 |
| **비프음 진단** | 별도 페이지 | 카메라 화면 하단 마이크 버튼으로 동시 진단. BiosType는 OCR로 자동 prefill |
| **종료** | 우상단 빨간 종료 버튼 | 좌상단 작은 [×] (덜 위협적) + 하단 메인 액션은 "다음 단계/완료" |
| **결과** | "✅ 완료" 막다른 골목 | 진단 요약 카드 + "다른 작업 이어가기" 추천 + 이력 저장 |
| **시스템 상태** | 진단 시도 후 노출 | 첫 화면 우상단 작은 status dot (CV/카메라/네트워크 준비) |

---

## 7. 단계적 구현 plan

확정 범위: **P0 + P1 (2주)**

### 작업 순서 (의존성·안전성순)

| # | 작업 | 영향 파일 | 위험도 | 예상 시간 |
|---|---|---|---|---|
| 1 | **진입 즉시 카메라화** — `PwaPage` 제거 또는 fallback 강등, `LiveGuideMode` 디폴트 컨텍스트 prefill | `App.tsx`, `PwaPage.tsx`, `LiveGuideMode.tsx` | 낮음 | 1~2h |
| 2 | **`ShootingGuide` 토스트화** — 풀스크린 → 카메라 위 dismissible 토스트 (첫 1회 + ? 버튼 재호출) | `ShootingGuide.tsx`, `LiveGuideMode.tsx`, `mobile.css` | 낮음 | 2~3h |
| 3 | **CV Insight 패널** — 우상단, 모서리/OCR/품질/변화감지 라이브 표시 (`canvas` 가시화 포함) | `LiveGuideMode.tsx` 신규 컴포넌트, `useLiveFrameCapture` 시그니처 확장 | 중간 (훅 리팩터) | 1~2일 |
| 4 | **풀업 시트 컨텍스트 전환** — `GuideContextSelector` 시트 안으로 이동 | `LiveGuideMode.tsx`, `mobile.css` | 낮음 | 4~6h |
| 5 | **Thumb-zone 액션 바** — 하단 [마이크 / 다음·완료 / ?] | `LiveGuideMode.tsx`, `mobile.css` | 낮음 | 4~6h |
| 6 | **자동 vendor 감지** — 모듈 1 OCR 텍스트에서 AMI/Award/Phoenix 키워드 추출 → BiosType prefill | `biosPipeline.ts` 또는 신규 헬퍼, `AudioCapture.tsx` | 중간 | 1일 |
| 7 | **AR 오버레이** — 모듈 1 검출 4 모서리 + OCR ROI를 카메라 위 SVG/Canvas로 렌더 | `LiveGuideMode.tsx`, `useBiosPipeline` 시그니처 확장 | 높음 (좌표 변환) | 2~3일 |

### 주차별 마일스톤

**Week 1 (P0 + P1 일부)**
- ✅ 작업 1, 2 완료 → "앱 진입 = 카메라" 체험 확보
- ✅ 작업 3 완료 → CV가 시각화되어 평가자에게 보임
- ✅ 작업 4 완료 → 컨텍스트 전환 시트 동작

**Week 2 (P1 마무리)**
- ✅ 작업 5 완료 → 한손 조작 인체공학 개선
- ✅ 작업 6 완료 → 비프음 흐름 자동 prefill
- ✅ 작업 7 완료 → AR 오버레이로 CV 어필 극대화
- 📹 demo 영상 재촬영

---

## 8. 트레이드오프 / 리스크

| 결정 | 이득 | 비용 | 완화책 |
|---|---|---|---|
| 즉시 카메라 진입 | 마찰 ↓, 모바일 앱답게 | 권한 거부 시 dead state | Manual Mode 폴백 (사진 업로드 + 비프음만) |
| CV Insight 패널 노출 | CV 어필 ↑ (텀프 핵심) | 화면 정보 1개 추가 | thumb zone 정리로 상쇄, 토글 가능하게 설계 |
| AR 오버레이 | "AI가 보고 있다" 가시화 | OpenCV.js + Canvas 좌표 변환 추가 구현 (≈2~3일) | 시간 부족 시 작업 7 컷, 작업 3의 정적 오버레이로 갈음 |
| 비프음을 카메라 화면 안으로 | 흐름 통합 | 화면 더 복잡해짐 | 시트로 분리 (메인 액션 바에 마이크 아이콘만) |
| 자동 vendor 감지 | 입력 단계 ↓ | 오감지 시 사용자 좌절 | "이거 아니에요?" affordance + 수동 변경 폴백 유지 |
| 홈 카드 제거 | 메인 메시지 강화 | 비프음 진단 진입성 ↓ | Thumb-zone 액션 바 마이크 아이콘으로 항상 노출 |

---

## 9. CV 텀프로젝트 점수 기여 분석

| 변경 | 평가 영향 |
|---|---|
| **CV Insight 패널** (작업 3) | 평가자/시연 영상 첫 화면에서 "OpenCV가 매 프레임 작동 중" 즉시 인식. ablation 결과(모듈 2/3)와 라이브 동작이 시각적으로 연결됨 |
| **AR 오버레이** (작업 7) | 모듈 1(Hough+Homography)이 검출한 모서리·OCR ROI가 카메라 위에 보임 → "왜 클래식 OpenCV인가"의 답이 시각화됨 |
| **자동 vendor 감지** (작업 6) | 모듈 1 OCR 출력의 실제 활용 사례 → "OCR 정확도 89.2%"가 단순 ablation 수치가 아니라 사용자 가치로 연결됨 |
| **Camera-First 진입** (작업 1) | demo 영상 30초 안에 "카메라 켜짐 → CV 작동 → AI 안내" 풀 흐름 시연 가능 |
| **풀업 시트 + Thumb-zone** (작업 4, 5) | UX 완성도 가점 (평가축 "완성도") |

→ 본 리뉴얼은 **단순 디자인 개선이 아니라 CV depth 어필의 가시화 작업**. 같은 알고리즘 코드가 같은 ablation 수치를 내더라도, 시각적 노출 여부에 따라 평가자가 인식하는 "깊이"가 달라짐.

---

## 10. 다음 단계

1. 본 문서 검토 후 **작업 1번부터 착수**
2. 각 작업 완료 시 짧은 데모(스크린샷·GIF) 첨부하여 진행 보고
3. Week 1 종료 시점에 demo 시나리오 1차 점검
4. Week 2 종료 후 README 업데이트 + demo 영상 재촬영

### 관련 문서

- `.claude/rules/cv-modules.md` — CV 모듈 1/2/3 명세
- `.claude/rules/cv-workflow.md` — Python ↔ OpenCV.js 이식 흐름
- `.claude/rules/evaluation-metrics.md` — README 양식 + 점수 시뮬레이션
- `.claude/rules/figma-design-system.md` — 색·폰트·카드 토큰 (본 리뉴얼은 토큰을 그대로 재사용)
- `.claude/rules/snippets.md` — `[Live Guide]` 함정 패턴 (그대로 유지)

### 갱신 예정 문서

본 리뉴얼 착수 후 갱신해야 할 항목:
- `.claude/rules/workflow.md` — "HW 진단 흐름 (PWA)" 단락을 Camera-First 흐름으로 교체
- `.claude/rules/workflow-diagram.md` — Phase 7-B 시퀀스 다이어그램 갱신
- `CLAUDE.md` — "진단 모드 분리" 표를 메인(PWA)/보조(Electron) 구조로 갱신
- `README.md` — 메인 다이어그램을 PWA → CV 파이프라인 중심으로
