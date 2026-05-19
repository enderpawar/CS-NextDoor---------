// ── 공유 타입 정의 ──────────────────────────────────────────────────────────
// API 응답 타입은 반드시 이 파일에서 중앙 관리. 컴포넌트 파일에 직접 정의 금지.
// Phase 진행에 따라 타입 추가. any 사용 금지 (OpenCV cv.* API 제외).

// ── 런타임 모드 ──────────────────────────────────────────────────────────────

export type RuntimeMode = 'electron' | 'pwa-session' | 'pwa-standalone';

// ── UI 공통 ───────────────────────────────────────────────────────────────────

// 클립보드 이미지 붙여넣기 (App.tsx paste 이벤트, diagnosisApi 전송 시 재사용)
export interface ClipboardImage {
  dataUrl: string; // FileReader 결과 — Gemini 전송 시 base64 부분만 추출
  file: File;
}

// ── 진단 도메인 ──────────────────────────────────────────────────────────────

export interface DiagnosisResponse {
  cause: string;
  solution: string;
  confidence: number;    // 0.0 ~ 1.0. 0.6 미만 → 수리기사 권장 배너
  parts?: string[];      // ["RAM", "GPU"] — PartCategory enum 값
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  priority: 'A' | 'B' | 'C'; // A: 직접 시도 가능, C: 전문 개입 필요
  confidence: number;
  status: 'pending' | 'trying' | 'resolved' | 'failed';
}

export interface HypothesesResponse {
  diagnosisId: string;
  hypotheses: Hypothesis[];
  immediateAction?: string;
}

export interface FeedbackRequest {
  status: 'RESOLVED' | 'UNRESOLVED';
  note?: string;
}

// ── Phase 5: SW 진단 풀 플로우 ────────────────────────────────────────────────

export interface SystemMetrics {
  cpuUsage: number;       // 0~100 %
  memoryUsed: number;     // bytes
  memoryTotal: number;    // bytes
  cpuDeltaPct?: number;   // 재현 후 상대 변화율 %
  memoryDeltaMB?: number; // 재현 후 변화량 MB
}

export interface SoftwareDiagnosisRequest {
  diagnosisId: string;
  hypothesisId: string;
  hypothesisTitle: string;
  symptom: string;
  baseline: SystemMetrics;
  delta: SystemMetrics;
  previousDiagnosisId?: string; // "이게 전부가 아닐 수 있어요" 재진단 시
}

export interface SoftwareDiagnosisResponse {
  diagnosisId: string;
  confirmedHypothesis: string;
  cause: string;
  solution: string;
  confidence: number;        // 0.0~1.0
  requiresRepairShop: boolean;
  isComplex: boolean;        // SW+HW 복합 원인 의심
}

export interface PatternSuggestion {
  id: string;
  title: string;
  description: string;
  matchReason: string;
  relevanceScore: number;
}

export interface PatternsResponse {
  patterns: PatternSuggestion[];
  summary: string; // 빈 패턴 시 "간헐적 증상이라 지금 당장 파악이 어려워요"
}

// ── 세션 ─────────────────────────────────────────────────────────────────────

export type SessionType =
  | 'PWA_ONLY'  // PWA 앱 시작 시 자동 생성. QR 스캔 전까지 SW 데이터 없음
  | 'LINKED';   // Electron QR 스캔으로 합류. PWA_ONLY 세션은 이 시점에 폐기됨

export interface SessionInfo {
  sessionId: string;
  sessionType: SessionType;
  authToken: string;
  shortCode: string;     // 6자리 수동 입력 폴백용
  expiresAt: string;     // ISO 8601
}

// ── Phase 8: BIOS + Audio ─────────────────────────────────────────────────────

export type BiosType = 'AMI' | 'Award' | 'Phoenix' | 'OTHER';

export type RecordingState = 'idle' | 'recording' | 'recorded';

// ── Live Camera Guide Mode ────────────────────────────────────────────────────

export type GuideContext =
  | 'GENERAL'            // 사용자가 상황을 특정하지 못함 — 화면 단서로 먼저 분류
  | 'NO_BOOT'            // 전원은 들어오지만 부팅/화면 표시 실패
  | 'SLOW_PC'            // 성능 저하, 멈춤, 발열, 팬 소음
  | 'APP_NOT_OPENING'    // 프로그램 실행 불가, 오류 팝업
  | 'NETWORK_ISSUE'      // 인터넷, Wi-Fi, DNS, 공유기 문제
  | 'BLUE_SCREEN'        // BSOD, 오류 코드, 자동 재부팅
  | 'BIOS_BOOT'          // BIOS/부팅 순서/Secure Boot/Windows 설치
  | 'HW_REPAIR_RAM'      // 케이스 분해 후 RAM 재장착·접점 청소
  | 'HW_REPAIR_GPU';     // 케이스 분해 후 GPU 재장착·전원 케이블 확인

// HW 조치 컨텍스트 판별 헬퍼 — 프롬프트·UI·CV 분기에서 재사용
export const HW_REPAIR_CONTEXTS: readonly GuideContext[] = ['HW_REPAIR_RAM', 'HW_REPAIR_GPU'] as const;
export function isHwRepairContext(context: GuideContext): boolean {
  return HW_REPAIR_CONTEXTS.includes(context);
}

export interface GuideMessage {
  role: 'user' | 'model';
  text: string;
}

export interface GuideSession {
  sessionId: string;
  context: GuideContext;
  status: 'ACTIVE' | 'DONE';
}

export interface GuideOcrRegion {
  id: string;
  text: string;
  confidence: number;
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  points: number[][];
}

export interface GuideArTarget {
  targetId?: string;
  label: string;
  reason?: string;
  // 'click' = 화면 UI 클릭(초록), 'action' = 물리 부품 조치(주황 점선). 기본값 'click'.
  mode?: 'click' | 'action';
  bbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
    unit?: 'normalized1000' | 'normalized01' | 'pixel';
  };
}

// ── CV Harness / Frame Analysis ──────────────────────────────────────────────

export type FrameGuidance =
  | 'ready'
  | 'stabilize'
  | 'too_dark'
  | 'too_bright'
  | 'no_target'
  | 'too_far';

export interface CvFrameInput {
  id: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  timestampMs?: number;
}

export interface CvFrameMetrics {
  id: string;
  width: number;
  height: number;
  brightnessMean: number;    // 0.0~1.0
  brightnessStdDev: number;  // 0.0~1.0
  laplacianVariance: number;
  sharpnessScore: number;    // 0.0~1.0
  edgeDensity: number;       // 0.0~1.0
  coverageRatio: number;     // 0.0~1.0
  histogram: number[];
  histogramSimilarity?: number;
  sceneChangeScore?: number; // 0.0~1.0
  qualityScore: number;      // 0~100
  guidance: FrameGuidance;
  guidanceText: string;
  isUsable: boolean;
}

export interface CvAnalysisOptions {
  edgeThreshold?: number;
  minSharpness?: number;
  minCoverageRatio?: number;
  minBrightness?: number;
  maxBrightness?: number;
  histogramBins?: number;
  sceneChangeThreshold?: number;
}

export interface CvFrameCandidate {
  frame: CvFrameInput;
  metrics: CvFrameMetrics;
}
