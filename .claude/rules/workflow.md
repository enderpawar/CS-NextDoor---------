# 시스템 워크플로우

> PC 상태에 따라 두 가지 진입점. **3단계 플로우**: 증상 입력 → 가설 추적(해결됐나요 분기) → 재현 모드(delta 계산) → 복합 원인 계속 진단 → 사후 확인.
> Phase 5에서 PatternSelector·HW 에스컬레이션은 UI에서 제거(Phase 11로 이관).
>
> 상세 시퀀스 다이어그램: `.claude/rules/workflow-diagram.md`

---

## 진입 분기

| 상황 | 진입점 | 첫 화면 |
|---|---|---|
| PC 정상 부팅 | Electron | 증상 입력 + 시스템 스냅샷 자동 수집 |
| PC 부팅 불가 | PWA 직접 접속 | ⚠️ SW 데이터 없음 — 정확도 제한 안내 |

---

## SW 진단 흐름 (Electron) — Phase 5 구현 기준

> **3단계 UI**: 증상 입력(1) → 가설 추적(2) → 재현 모드(3)
> 줌 전환 애니메이션 후 풀스크린 채팅 뷰(`nd-chat-fullview`)로 전환.

1. 증상 텍스트 입력 (Ctrl+V 클립보드 이미지 첨부 가능) + BIOS 제조사 자동 감지
2. `POST /api/diagnosis/hypotheses` → 가설 A/B/C + 신뢰도% + 즉시 조치
   - confidence < 0.6인 가설 카드마다 "수리기사 상담 권장" 배너 자동 표시
3. **HypothesisTracker**: 가설을 우선순위대로 순차 시도. 상태 흐름:
   - `이 조치 시도하기` → `해봤어요` / `효과 없어요`
   - `해봤어요` → **"해결됐나요?" 분기**: `해결됐어요`(→ done) / `아직 안 됐어요`(→ failed)
   - `효과 없어요` → 즉시 failed
   - 어떤 가설이라도 **done** 시 → 초록 완료 카드 표시 + 플로우 종료
4. 모든 가설 소진(all done/failed) & 미해결 → **재현 모드** (채팅 피드 인라인 UI):
   - 1단계: 베이스라인 저장 (현재 CPU/메모리 스냅샷). CPU ≥ 90% 또는 메모리 ≥ 95% 시 경고 표시
   - 2단계: 문제 재현 (사용자가 직접 증상 유발)
   - 결과: CPU delta ≥ 15%p 또는 메모리 delta ≥ 10%p → "소프트웨어 원인 확인" / 미달 → "간헐적 증상, 수리기사 권장"
5. 재현 모드 완료 후 미해결 → "이게 전부가 아닐 수 있어요" 버튼(allExhausted && !isResolved 조건) → 가설 초기화 후 재진단

> **제거된 항목 (Phase 5 단순화)**: PatternSelector, HW 에스컬레이션(QR) — Phase 11에서 구현
> **현재 Mock 상태**: `USE_MOCK = true` (`src/api/diagnosisApi.ts`). 백엔드 준비 시 false로 변경

---

## HW 진단 흐름 (PWA)

1. BIOS 제조사 확인 (세션 모드: 자동 수신 / 독립·감지 실패: BiosTypeSelector 수동 선택)
2. **ShootingGuide**: 부위별 촬영 다이어그램 + 거리/각도 안내
3. 후면 카메라 + 마이크(AEC 비활성) + OpenCV 오버레이 → VideoAnalysis 프레임 추출
4. `POST /api/diagnosis/hardware` (독립) 또는 `POST /api/session/{id}/hardware` (세션)
5. Gemini ← MCP `get_manual_info(biosType, errorCode)` → HW 진단 결과 + 신뢰도%
6. 세션 모드: WS → DONE 이벤트 → Electron에도 결과 표시

---

## Phase 7-B — 라이브 카메라 가이드 모드 (CV 텀프로젝트 메인 쇼케이스)

> BIOS 설정·Windows 설치 등 화면 작업을 카메라로 비추면 Gemini가 단계별 안내.
> **CV 모듈 1/2/3 모두 이 Phase에서 통합 동작**. 자세한 모듈 명세는 `cv-modules.md`.

### CV 파이프라인 통합 흐름

```
카메라 프레임 (RGBA Canvas)
 ↓
[모듈 3] 프레임 품질 게이트 — Laplacian variance + 밝기 통계 + Optical Flow
   ↓ 통과       ↓ 거부
   ↓           → 사용자 피드백 ("흔들렸어요" / "너무 어두워요")
 ↓
[모듈 2] 히스토그램 변화 감지 — 4 메트릭 후보 중 베스트(노트북에서 결정)
   ↓ 3프레임 연속 변화 + 쿨다운 + isSendingRef=false
 ↓
[모듈 1] BIOS 화면 파이프라인 — Hough+Homography → CLAHE → Threshold → CC → Tesseract.js
   ↓ 정면화 + OCR 텍스트
 ↓
Gemini Vision — 텍스트 + 원본 이미지 + 컨텍스트로 자연어 안내 생성
 ↓
SSE 스트리밍 → GuideBubble 타이핑 표시
```

**핵심 설계 원칙**:
- rAF 루프 히스토그램 비교 → **연속 3프레임 변화 감지** 시만 Gemini 전송 (false positive 차단)
- OpenCV.js: **모듈 1/2/3 모두 OpenCV.js로 이식** (Python 노트북 검증 후)
- Tesseract.js: 사전 학습 모델 inference만 사용 (학습/finetune 없음)
- 세션 시작 즉시 `STATIC_FIRST_GUIDE[context]` 표시 → Gemini 응답 도착 시 교체
- 프레임 전송 후 3단계 피드백: 📸 캡처됨 → ⏳ 분석 중+경과시간 → 응답 도착
- 응답 도착 시 전송 당시 히스토그램 vs 현재 비교 → 유사도 < 0.7 시 stale guide 경고

**비용 제어**:

| 방법 | 효과 |
|---|---|
| 히스토그램 유사도 임계값 0.92 | 동일 화면 반복 전송 차단 |
| **연속 3프레임 변화 확인** | 손 떨림/Rolling Shutter false positive 차단 |
| 최소 전송 간격 2초 쿨다운 | 초당 다중 호출 방지 |
| `isSendingRef` 동시 전송 차단 | 이전 응답 완료 전 새 프레임 무시 |
| `AbortController` 연결 | 언마운트/종료 시 진행 중 스트림 즉시 취소 |
| 대화 히스토리 최대 6턴 슬라이딩 | 토큰 누적 방지 |
| `[완료]` 태그 누적 버퍼 기준 감지 | 청크 분할 무관 세션 자동 종료 보장 |
| 세션 최대 수명 15분 | 방치 세션 비용 차단 |

---

## 공통 완료 흐름

- 해결됨 → `POST /api/diagnosis/{id}/feedback (RESOLVED)` → 24시간 사후 확인 스케줄
- 복합 원인 의심 → "이게 전부가 아닐 수 있어요" 버튼 → `previousDiagnosisId` 포함 재진단
- 신뢰도 < 0.6 → "수리기사 상담 권장" 배너 자동 표시

---

## CV 텀프로젝트 — 스코프 결정

본 저장소는 **CV 과목 텀프로젝트 (마감 2026-06-07)** 입니다.

| 흐름 | 텀프로젝트 스코프 | 비고 |
|---|---|---|
| SW 진단 흐름 (Phase 5 완료) | ✅ 유지 | 풀스택 완성도 어필 |
| Phase 6 / 7 / 7-B (CV 코어) | ⭐ 필수 | CV 모듈 1/2/3 통합 |
| Phase 8 (BIOS 감지 + 비프음) | △ 시간 시 | CV 모듈 4 선택 |
| Phase 9 (MCP) | 🚫 Future Work | README 명시 |
| Phase 10 (DB 이력 + 사후) | 🚫 Future Work | README 명시 |
| Phase 11 (세션 인증 QR) | 🚫 Future Work | README 명시 |

> Phase 9~11의 워크플로 다이어그램 일부 화살표는 본 텀프로젝트 범위 밖.
> 완전한 시퀀스 다이어그램은 `workflow-diagram.md` 참조 (장기 비전).
