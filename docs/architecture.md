# 시스템 아키텍처

> README에 임베드할 시스템 다이어그램 + 컴포넌트 설명.
> Mermaid는 GitHub에서 직접 렌더링됨.

## 전체 시스템

```mermaid
flowchart LR
    subgraph Mobile [Mobile PWA - 하드웨어 진단]
        Cam[카메라/마이크] --> CV[OpenCV.js 파이프라인]
        CV --> LiveGuide[LiveGuideMode]
        CV --> Shoot[ShootingGuide]
    end

    subgraph Desktop [Desktop Electron - 소프트웨어 진단]
        SysInfo[systeminformation] --> SysDash[SystemDashboard]
        EventLog[Event Log] --> Hyp[HypothesisTracker]
    end

    subgraph Backend [Spring Boot + PostgreSQL]
        Diag[DiagnosisController]
        Sess[SessionController]
        Guide[GuideController]
    end

    LiveGuide --> Guide
    Shoot --> Diag
    Hyp --> Diag
    Guide --> GeminiVision[Gemini Vision]
    Diag --> GeminiVision
    Sess --> WS[(WebSocket STOMP)]
    WS --> Mobile
    WS --> Desktop
```

## CV 파이프라인 (Phase 7-B 라이브 가이드)

```mermaid
flowchart TB
    Frame[Camera Frame] --> Quality{프레임 품질 필터<br/>모듈 3}
    Quality -->|좋음| Hist[히스토그램 변화 감지<br/>모듈 2]
    Quality -->|나쁨| Reject[거부 + 사용자 피드백]
    Hist -->|3프레임 연속 변화| BIOS[BIOS 화면 파이프라인<br/>모듈 1]
    Hist -->|변화 없음| Wait[프레임 무시]
    BIOS --> Homo[Hough Line + Homography<br/>정면화]
    Homo --> CLAHE[CLAHE 대비 강화]
    CLAHE --> Thresh[Adaptive Threshold]
    Thresh --> CC[Connected Components<br/>텍스트 영역 분리]
    CC --> OCR[Tesseract.js OCR]
    OCR --> Match[Levenshtein 메뉴 매칭]
    Match --> Gemini[Gemini Vision<br/>의미 해석 + 단계 안내]
```

## 컴포넌트 책임 분리

| 레이어 | 책임 | 사용 기술 |
|---|---|---|
| **OpenCV.js (브라우저)** | 변화 감지·전처리·정면화·OCR 전처리 | Hough, Homography, CLAHE, Threshold |
| **Tesseract.js** | 텍스트 추출 | LSTM 기반 OCR (학습된 모델 사용, finetune 없음) |
| **Gemini Vision** | 의미 해석 + 자연어 안내 생성 | Multimodal LLM |
| **Spring Boot** | SSE 스트리밍 + 세션 관리 + Gemini 프록시 | SseEmitter |
| **PostgreSQL** | 진단 이력 + 세션 (Phase 10) | JPA |

> **CV 모듈은 클래식 OpenCV만 사용** (딥러닝 학습 없음).
> Tesseract.js는 사전 학습된 모델을 inference만 — 학습 작업 없음.
