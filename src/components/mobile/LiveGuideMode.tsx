/**
 * LiveGuideMode — Camera-First 리뉴얼 (docs/ux-redesign.md Task 1+2+3+4)
 *
 * 변경 사항:
 *   - 앱 진입 즉시 카메라 시작 (기존 4-step → 1-step)
 *   - ShootingGuide: 별도 페이지 → 카메라 위 dismissible 오버레이
 *   - 컨텍스트 선택: 풀스크린 그리드 → 풀업 시트 (상단바 버튼 탭)
 *   - CV Insight 패널: 우상단 오버레이 — OpenCV 라이브 메트릭 시각화 (Task 3)
 *   - 디폴트 컨텍스트: NO_BOOT
 *
 * CV 모듈 통합 흐름 (변경 없음):
 *   카메라 → [모듈 3] 품질 게이트 → [모듈 2] 변화 감지(3프레임)
 *     → [모듈 1] BIOS 파이프라인 → Gemini Vision
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

import { useState, useRef, useCallback, useEffect } from 'react';
import '../../styles/mobile.css';
import { useOpenCV }                         from '../../hooks/useOpenCV';
import { useGeminiLiveGuide }                from '../../hooks/useGeminiLiveGuide';
import { useLiveFrameCapture }               from '../../hooks/useLiveFrameCapture';
import type { BiosArOverlay, CvFrameInsightMetrics } from '../../hooks/useLiveFrameCapture';
import GuideContextSelector                  from './GuideContextSelector';
import GoalInputSheet                        from './GoalInputSheet';
import GuideBubble                           from './GuideBubble';
import ShootingGuide                         from './ShootingGuide';
import CvInsightPanel                        from './CvInsightPanel';
import BiosTypeSelector                      from './BiosTypeSelector';
import AudioCapture                          from './AudioCapture';
import type { GuideArTarget, GuideContext, BiosType, GuideOcrRegion } from '../../types';
import { isHwRepairContext } from '../../types';
import { compareHist }                       from '../../lib/cv/changeDetection';
import {
  detectBiosVendor,
  preprocessBiosFrameForGuide,
  runBiosPipeline,
} from '../../lib/cv/biosPipeline';
import type { BiosTextRegion } from '../../lib/cv/biosPipeline';

// 세션 시작 즉시 표시할 컨텍스트별 정적 안내 (Gemini 응답 전 공백 방지)
const STATIC_FIRST_GUIDE: Record<GuideContext, string> = {
  GENERAL:         'PC 화면을 비춰주세요. 화면 단서를 먼저 보고 어떤 문제인지 분류한 뒤 단계별로 안내할게요.',
  NO_BOOT:         'PC 본체 전원 LED, 모니터 화면, 제조사 로고가 보이는지 차례로 확인할게요.',
  SLOW_PC:         '작업 관리자나 느려지는 화면을 비춰주세요. CPU, 메모리, 디스크 사용률 단서를 같이 볼게요.',
  APP_NOT_OPENING: '실행되지 않는 프로그램의 오류 창이나 멈춘 화면을 비춰주세요.',
  NETWORK_ISSUE:   'Wi-Fi 아이콘, 네트워크 설정 화면, 공유기 상태 등 보이는 단서를 비춰주세요.',
  BLUE_SCREEN:     '블루스크린의 중지 코드나 오류 메시지가 보이도록 화면을 비춰주세요.',
  BIOS_BOOT:       'BIOS, 부팅 메뉴, Windows 설치 화면을 비춰주세요. 현재 위치에 맞춰 다음 조작을 안내할게요.',
  HW_REPAIR_RAM:   'PC 케이스를 연 뒤 메인보드의 RAM 슬롯이 보이도록 비춰주세요. 어떤 메모리를 어떻게 빼고 다시 꽂아야 하는지 안내할게요.',
  HW_REPAIR_GPU:   'PC 케이스를 연 뒤 그래픽카드(GPU)와 PCIe 슬롯이 보이도록 비춰주세요. 분리·재장착 순서를 단계별로 안내할게요.',
};

const SHOW_CC_DEBUG_REGIONS = false;

type PageState = 'camera' | 'done';
type ActionResult = 'none' | 'tried' | 'unresolved';

interface FrozenFrame {
  dataUrl: string;
  width: number;
  height: number;
}

interface Props {
  initialContext?: GuideContext;
  initialQuestion?: string;
  onExit?: () => void;
}

/** cvSummary 문자열에서 bios 메트릭 파싱 */
function parseBiosFromSummary(cvSummary: string) {
  return {
    rectified:   cvSummary.includes('biosRectified=true'),
    textRegions: parseInt(cvSummary.match(/biosTextRegions=(\d+)/)?.[1] ?? '0', 10),
    processMs:   parseInt(cvSummary.match(/biosPreprocessMs=(\d+)/)?.[1] ?? '0', 10),
  };
}

function smoothQuadCorners(
  previous: number[][] | null,
  next: number[][] | null,
  alpha = 0.35,
): number[][] | null {
  if (!next) return null;
  if (!previous || previous.length !== next.length) return next;

  return next.map((point, index) => {
    const prevPoint = previous[index];
    if (!prevPoint) return point;
    return [
      (prevPoint[0] ?? 0) * (1 - alpha) + (point[0] ?? 0) * alpha,
      (prevPoint[1] ?? 0) * (1 - alpha) + (point[1] ?? 0) * alpha,
    ];
  });
}

function normalizeTargetText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}# ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreOcrRegionForCurrentStep(
  region: GuideOcrRegion,
  guideText: string,
  taskGoal: string,
  context: GuideContext,
): number {
  const regionText = normalizeTargetText(region.text);
  if (regionText.length < 2) return 0;

  const currentText = normalizeTargetText(`${guideText} ${taskGoal}`);
  let score = 0;

  if (currentText && currentText.includes(regionText) && regionText.length >= 4) {
    score += 80 + Math.min(regionText.length, 30);
  }

  for (const token of regionText.split(' ')) {
    if (token.length >= 4 && currentText.includes(token)) score += 18;
  }

  const actionKeywords = [
    'boot', 'secure', 'usb', 'save', 'exit', 'install', 'setup', 'advanced',
    'option', 'priority', 'windows', 'yes', 'ok', 'f10', 'del', 'enabled', 'disabled',
  ];
  for (const keyword of actionKeywords) {
    if (regionText.includes(keyword)) score += context === 'BIOS_BOOT' ? 14 : 6;
    if (currentText.includes(keyword) && regionText.includes(keyword)) score += 20;
  }

  score += Math.min(region.confidence * 10, 10);
  if (region.bbox.w < 12 || region.bbox.h < 8) score -= 20;
  if (regionText.length > 48) score -= 8;

  return score;
}

function pickFallbackOcrTarget(
  regions: GuideOcrRegion[],
  guideText: string,
  taskGoal: string,
  context: GuideContext,
): GuideOcrRegion | null {
  let best: { region: GuideOcrRegion; score: number } | null = null;
  for (const region of regions) {
    const score = scoreOcrRegionForCurrentStep(region, guideText, taskGoal, context);
    if (!best || score > best.score) best = { region, score };
  }
  if (!best) return null;
  if (best.score >= 18) return best.region;
  if (context === 'BIOS_BOOT' && regions.length > 0 && (guideText || taskGoal)) return best.region;
  return null;
}

function pickOcrTargetByArHint(
  regions: GuideOcrRegion[],
  label: string | undefined,
  reason: string | undefined,
  guideText: string,
  taskGoal: string,
  context: GuideContext,
): GuideOcrRegion | null {
  const hint = [label, reason, guideText, taskGoal].filter(Boolean).join(' ');
  return pickFallbackOcrTarget(regions, hint, taskGoal, context);
}

function textRegionToArTarget(region: BiosTextRegion | undefined): GuideOcrRegion | null {
  if (!region) return null;
  const xs = region.points.map(point => point[0] ?? 0);
  const ys = region.points.map(point => point[1] ?? 0);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 12 || h < 8) return null;
  if (w * h > 70_000) return null;

  return {
    id: `cc-${region.id}`,
    text: '',
    confidence: 0,
    bbox: { x: x0, y: y0, w, h },
    points: region.points,
  };
}

function arTargetBboxToRegion(
  target: GuideArTarget,
  videoSize: { w: number; h: number } | null,
): GuideOcrRegion | null {
  if (!videoSize || !target.bbox) return null;
  const { bbox } = target;
  const unit = bbox.unit ?? 'normalized1000';
  const scaleX = unit === 'pixel' ? 1 : unit === 'normalized01' ? videoSize.w : videoSize.w / 1000;
  const scaleY = unit === 'pixel' ? 1 : unit === 'normalized01' ? videoSize.h : videoSize.h / 1000;
  const x0 = clampValue(bbox.x * scaleX, 0, videoSize.w);
  const y0 = clampValue(bbox.y * scaleY, 0, videoSize.h);
  const x1 = clampValue((bbox.x + bbox.w) * scaleX, 0, videoSize.w);
  const y1 = clampValue((bbox.y + bbox.h) * scaleY, 0, videoSize.h);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return null;

  return {
    id: target.targetId ?? 'gemini-vision-bbox',
    text: '',
    confidence: 1,
    bbox: { x: x0, y: y0, w, h },
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function makeClickableTargetRegion(
  region: GuideOcrRegion,
  videoSize: { w: number; h: number } | null,
  mode: 'vision' | 'fallback' = 'fallback',
): GuideOcrRegion {
  if (!videoSize) return region;

  const isShortAction = /^(ok|yes|no|esc|del|f(?:1[0-2]|[1-9]))$/i.test(region.text.trim());
  const padX = mode === 'vision'
    ? Math.max(4, region.bbox.w * 0.04)
    : Math.max(isShortAction ? 30 : 18, region.bbox.w * 0.22);
  const padY = mode === 'vision'
    ? Math.max(3, region.bbox.h * 0.12)
    : Math.max(isShortAction ? 16 : 10, region.bbox.h * 0.72);
  const x0 = clampValue(region.bbox.x - padX, 0, videoSize.w);
  const y0 = clampValue(region.bbox.y - padY, 0, videoSize.h);
  const x1 = clampValue(region.bbox.x + region.bbox.w + padX, 0, videoSize.w);
  const y1 = clampValue(region.bbox.y + region.bbox.h + padY, 0, videoSize.h);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  return {
    ...region,
    bbox: { x: x0, y: y0, w, h },
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  };
}

function getTargetLabelPosition(
  target: GuideOcrRegion,
  videoSize: { w: number; h: number },
  labelWidth: number,
) {
  const aboveY = target.bbox.y - 42;
  const belowY = target.bbox.y + target.bbox.h + 10;
  const y = aboveY >= 0 ? aboveY : Math.min(videoSize.h - 32, belowY);
  const x = clampValue(target.bbox.x, 4, Math.max(4, videoSize.w - labelWidth - 4));
  return { x, y };
}

export default function LiveGuideMode({ initialContext = 'GENERAL', initialQuestion = '', onExit }: Props) {
  const [page,              setPage]             = useState<PageState>('camera');
  const [context,           setContext]          = useState<GuideContext>(initialContext);
  const [showShootingGuide, setShowShootingGuide] = useState(true);
  const [contextSheetOpen,  setContextSheetOpen] = useState(false);
  const [goalSheetOpen,     setGoalSheetOpen]    = useState(false);
  const [taskGoal,          setTaskGoalState]    = useState(initialQuestion.trim());
  const [qualityText,       setQualityText]      = useState('');
  const [streamError,       setStreamError]      = useState('');
  const [resolutionStep,    setResolutionStep]   = useState<'idle' | 'action-done' | 'hidden'>('hidden');
  const [questionDraft,     setQuestionDraft]    = useState(initialQuestion);
  const [exitConfirmOpen,   setExitConfirmOpen]  = useState(false);
  const [hwSafetyAck,       setHwSafetyAck]      = useState(false);  // HW 조치 안전 모달 1회 동의
  const [hwSafetyModalOpen, setHwSafetyModalOpen] = useState(false);

  // CV Insight 패널 상태 (Task 3)
  const [cvPanelOpen,   setCvPanelOpen]   = useState(false);
  const [cvMetrics,     setCvMetrics]     = useState<CvFrameInsightMetrics | null>(null);
  const [biosInsight,   setBiosInsight]   = useState<{ rectified: boolean; textRegions: number; processMs: number } | null>(null);

  // Thumb-zone 액션 바 상태 (Task 5)
  const [audioSheetOpen, setAudioSheetOpen] = useState(false);
  const [biosType,       setBiosType]       = useState<BiosType | null>(null);
  const [biosTypeSource, setBiosTypeSource] = useState<'auto' | 'manual' | null>(null);

  // Task 6 — 자동 vendor 감지 (Gemini 응답 텍스트 파싱)
  const [autoVendorChip, setAutoVendorChip] = useState<BiosType | null>(null);
  const vendorDetectedRef = useRef(false);  // 세션 내 1회만 감지

  // Task 7 — AR 오버레이 (Hough 모서리 + CC 텍스트 후보 + Gemini OCR 타깃)
  const [biosCorners,   setBiosCorners]   = useState<number[][] | null>(null);
  const [biosTextRegions, setBiosTextRegions] = useState<BiosTextRegion[]>([]);
  const [biosOcrRegions, setBiosOcrRegions] = useState<GuideOcrRegion[]>([]);
  const [biosVideoSize, setBiosVideoSize] = useState<{ w: number; h: number } | null>(null);
  const [frozenFrame, setFrozenFrame] = useState<FrozenFrame | null>(null);

  const videoRef              = useRef<HTMLVideoElement>(null);
  const canvasRef             = useRef<HTMLCanvasElement>(null);
  const fileInputRef          = useRef<HTMLInputElement>(null);
  const isSwitchingContextRef = useRef(false);
  const cameraStartingRef     = useRef(false);
  const smoothedCornersRef    = useRef<number[][] | null>(null);
  const overlaySizeRef        = useRef<{ w: number; h: number } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capturedHistRef = useRef<any>(null);
  const initialQuestionRef = useRef(initialQuestion.trim());
  const taskGoalRef = useRef(initialQuestion.trim());

  /** taskGoal state + ref를 함께 갱신 — 비동기 콜백은 ref.current를, 렌더링은 state를 사용 */
  const setTaskGoal = useCallback((value: string) => {
    const trimmed = value.trim();
    taskGoalRef.current = trimmed;
    setTaskGoalState(trimmed);
  }, []);

  const lastActionResultRef = useRef<ActionResult>('none');
  const pendingGalleryFrameRef = useRef<{
    base64: string;
    cvSummary: string;
    ocrRegions: GuideOcrRegion[];
    userQuestion?: string;
    taskGoal?: string;
  } | null>(null);

  const { cvReady } = useOpenCV();
  const guide = useGeminiLiveGuide();

  const clearFrozenGuideState = useCallback(() => {
    setFrozenFrame(null);
    setBiosCorners(null);
    setBiosTextRegions([]);
    setBiosOcrRegions([]);
    setBiosVideoSize(null);
    smoothedCornersRef.current = null;
    overlaySizeRef.current = null;
    guide.setArTarget(null);
  }, [guide.setArTarget]);

  // ── 프레임 변화 감지 후 전송 ────────────────────────────────────────────────
  const handleFrameChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (base64: string, histSnapshot: any, cvSummary: string) => {
      // 세션이 ACTIVE 상태일 때만 전송
      if (guide.session?.status !== 'ACTIVE') {
        histSnapshot?.delete();
        return;
      }
      // 프레임 전송 시 BIOS 파이프라인 결과 파싱 → 패널 업데이트
      setBiosInsight(parseBiosFromSummary(cvSummary));

      capturedHistRef.current?.delete();
      capturedHistRef.current = histSnapshot?.clone?.() ?? null;
      try {
        await guide.sendFrame(base64, histSnapshot, cvSummary, undefined, undefined, taskGoalRef.current || undefined);
      } catch {
        // sendFrame 내부에서 이미 처리됨
      }
    },
    [guide],
  );

  // ── 라이브 CV 메트릭 업데이트 (300ms 스로틀) ──────────────────────────────
  const handleMetricsUpdate = useCallback((m: CvFrameInsightMetrics) => {
    setCvMetrics(m);
  }, []);

  // ── Task 7: AR 오버레이 — Hough 모서리 EMA 스무딩 + CC 텍스트 후보 수신 ──
  const handleBiosOverlay = useCallback(
    ({ corners, textRegions, videoW, videoH }: BiosArOverlay) => {
      const previousSize = overlaySizeRef.current;
      const sizeChanged = !previousSize || previousSize.w !== videoW || previousSize.h !== videoH;
      const smoothedCorners = frozenFrame
        ? corners
        : smoothQuadCorners(sizeChanged ? null : smoothedCornersRef.current, corners);
      overlaySizeRef.current = { w: videoW, h: videoH };
      smoothedCornersRef.current = smoothedCorners;
      setBiosCorners(smoothedCorners);
      setBiosVideoSize({ w: videoW, h: videoH });
      setBiosTextRegions(textRegions);
    },
    [frozenFrame],
  );

  const handleBiosTypeSelect = useCallback((type: BiosType) => {
    setBiosType(type);
    setBiosTypeSource('manual');
    setAutoVendorChip(null);
    vendorDetectedRef.current = true;
  }, []);

  const applyDetectedVendor = useCallback((vendor: BiosType) => {
    if (vendorDetectedRef.current || biosTypeSource === 'manual') return;
    vendorDetectedRef.current = true;
    setBiosType(vendor);
    setBiosTypeSource('auto');
    setAutoVendorChip(vendor);
    window.setTimeout(() => setAutoVendorChip(null), 4000);
  }, [biosTypeSource]);

  // ── 갤러리 이미지 업로드 → CV 전처리 → Gemini 전송 ──────────────────────
  const handleGallerySelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';   // 동일 파일 재선택 허용

      // 이미지 로드
      const img = new Image();
      const url = URL.createObjectURL(file);
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload  = () => resolve();
          img.onerror = () => reject();
          img.src = url;
        });
      } catch {
        setStreamError('이미지를 불러올 수 없어요.');
        return;
      } finally {
        URL.revokeObjectURL(url);
      }

      // off-screen canvas에 그리기 — 최대 1280px로 리사이즈 (rAF 루프와 canvasRef 충돌 방지)
      const MAX_SIDE = 1280;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const offCanvas = document.createElement('canvas');
      offCanvas.width  = Math.round(img.naturalWidth  * scale);
      offCanvas.height = Math.round(img.naturalHeight * scale);
      const ctx = offCanvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      setFrozenFrame({
        dataUrl: offCanvas.toDataURL('image/jpeg', 0.85),
        width: offCanvas.width,
        height: offCanvas.height,
      });

      const rgba = ctx.getImageData(0, 0, offCanvas.width, offCanvas.height);
      let base64 = offCanvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
      const initialQuestionForFrame = !guide.streamText ? initialQuestionRef.current : '';
      if (initialQuestionForFrame && !taskGoalRef.current) setTaskGoal(initialQuestionForFrame);
      let cvSummary = [
        'galleryUpload=true',
        initialQuestionForFrame ? 'userQuestion=true' : 'userQuestion=false',
        initialQuestionForFrame ? 'guidePhase=question-initial' : 'guidePhase=initial',
        `previousActionResult=${lastActionResultRef.current}`,
      ].join(', ');

      // 모듈 1: BIOS 전처리 (CLAHE 강화 + Hough 모서리)
      if (cvReady) {
        try {
          const preprocessed = preprocessBiosFrameForGuide(rgba);
          cvSummary = [
            cvSummary,
            `biosRectified=${preprocessed.rectified}`,
            `biosTextRegions=${preprocessed.textRegionCount}`,
            `biosPreprocessMs=${Math.round(preprocessed.processingMs)}`,
          ].join(', ');
          handleBiosOverlay({
            corners: preprocessed.corners,
            textRegions: preprocessed.textRegions,
            videoW: offCanvas.width,
            videoH: offCanvas.height,
          });
          setBiosInsight({
            rectified:   preprocessed.rectified,
            textRegions: preprocessed.textRegionCount,
            processMs:   Math.round(preprocessed.processingMs),
          });
        } catch {
          // 전처리 실패 → 원본 이미지로 계속
        }
      }

      let galleryOcrRegions: GuideOcrRegion[] = [];
      if (cvReady) {
        try {
          const ocrResult = await runBiosPipeline(rgba);
          galleryOcrRegions = ocrResult.ocrRegions;
          setBiosOcrRegions(galleryOcrRegions);
          if (ocrResult.detectedVendor) applyDetectedVendor(ocrResult.detectedVendor);
          cvSummary = [
            cvSummary,
            `ocrRegions=${galleryOcrRegions.length}`,
            `ocrConfidence=${ocrResult.confidence.toFixed(2)}`,
          ].join(', ');
        } catch {
          setBiosOcrRegions([]);
        }
      }

      pendingGalleryFrameRef.current = {
        base64,
        cvSummary,
        ocrRegions: galleryOcrRegions,
        userQuestion: initialQuestionForFrame || undefined,
        taskGoal: taskGoalRef.current || initialQuestionForFrame || undefined,
      };

      if (guide.session?.status === 'ACTIVE') {
        // 이미 세션 활성 → 즉시 전송
        pendingGalleryFrameRef.current = null;
        try {
          await guide.sendFrame(
            base64,
            null,
            cvSummary,
            galleryOcrRegions,
            initialQuestionForFrame || undefined,
            taskGoalRef.current || initialQuestionForFrame || undefined,
          );
          if (initialQuestionForFrame) initialQuestionRef.current = '';
          lastActionResultRef.current = 'none';
        } catch { /* 내부 처리 */ }
      } else {
        // 세션 없음 → ShootingGuide 닫고 자동 시작 (완료 후 pendingGalleryFrameRef useEffect가 전송)
        setShowShootingGuide(false);
        setStreamError('');
        try {
          await guide.startSession(context);
        } catch {
          setStreamError('가이드 세션을 시작할 수 없어요.');
          pendingGalleryFrameRef.current = null;
        }
      }
    },
    [cvReady, guide, context, handleBiosOverlay, applyDetectedVendor, setTaskGoal],
  );

  // ── 수동 프레임 캡처 ("다음 단계" 버튼) ──────────────────────────────────
  const handleManualCapture = useCallback(async (userQuestion?: string, actionResultOverride?: ActionResult) => {
    const shouldUseInitialQuestion = !userQuestion?.trim() && !guide.streamText && !!initialQuestionRef.current;
    const question = userQuestion?.trim() || (shouldUseInitialQuestion ? initialQuestionRef.current : '');
    const actionResult = actionResultOverride ?? lastActionResultRef.current;
    const effectiveGoal = taskGoalRef.current || question;
    if (effectiveGoal && !taskGoalRef.current) setTaskGoal(effectiveGoal);
    if (guide.isSendingRef.current || guide.session?.status !== 'ACTIVE') return;
    if (guide.streamText && resolutionStep === 'idle' && !question) {
      setQualityText('먼저 안내한 조치를 해본 뒤 결과를 선택해주세요.');
      return;
    }

    if (question && frozenFrame) {
      const base64 = frozenFrame.dataUrl.split(',')[1] ?? '';
      if (!base64) {
        setQualityText('정지 화면을 읽지 못했어요. 현재 화면을 다시 분석해주세요.');
        return;
      }
      const cvSummary = [
        'userQuestion=true',
        'frozenFrame=true',
        guide.streamText ? 'guidePhase=question-followup' : 'guidePhase=question-initial',
        `previousActionResult=${actionResult}`,
        `ocrRegions=${biosOcrRegions.length}`,
      ].join(', ');
      setQualityText('');
      try {
        await guide.sendFrame(base64, null, cvSummary, biosOcrRegions, question, effectiveGoal || undefined);
        if (shouldUseInitialQuestion) initialQuestionRef.current = '';
        lastActionResultRef.current = 'none';
      } catch {
        // sendFrame 내부에서 처리됨
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const video = videoRef.current;
    const videoReady = !!video && video.readyState >= 2 && video.videoWidth > 0;
    canvas.width  = videoReady ? video!.videoWidth  : 640;
    canvas.height = videoReady ? video!.videoHeight : 360;
    if (videoReady) ctx.drawImage(video!, 0, 0);
    else            ctx.clearRect(0, 0, canvas.width, canvas.height);

    setFrozenFrame({
      dataUrl: canvas.toDataURL('image/jpeg', 0.85),
      width: canvas.width,
      height: canvas.height,
    });

    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '';
    let cvSummary = [
      'manualCapture=true',
      question ? 'userQuestion=true' : 'userQuestion=false',
      question
        ? (guide.streamText ? 'guidePhase=question-followup' : 'guidePhase=question-initial')
        : (guide.streamText ? 'guidePhase=followup' : 'guidePhase=initial'),
      `previousActionResult=${actionResult}`,
    ].join(', ');

    try {
      if (!cvReady) throw new Error('cv not ready');
      const preprocessed = preprocessBiosFrameForGuide(rgba);
      setBiosInsight({
        rectified: preprocessed.rectified,
        textRegions: preprocessed.textRegionCount,
        processMs: Math.round(preprocessed.processingMs),
      });
      handleBiosOverlay({
        corners: preprocessed.corners,
        textRegions: preprocessed.textRegions,
        videoW: canvas.width,
        videoH: canvas.height,
      });
      cvSummary = [
        cvSummary,
        `biosRectified=${preprocessed.rectified}`,
        `biosTextRegions=${preprocessed.textRegionCount}`,
        `biosPreprocessMs=${Math.round(preprocessed.processingMs)}`,
      ].join(', ');
    } catch {
      setBiosCorners(null);
      setBiosTextRegions([]);
      cvSummary = `${cvSummary}, biosPreprocess=failed`;
    }

    let ocrRegions: GuideOcrRegion[] = [];
    if (cvReady) {
      const ocrFrame = new ImageData(
        new Uint8ClampedArray(rgba.data),
        rgba.width,
        rgba.height,
      );
      try {
        const ocrResult = await runBiosPipeline(ocrFrame);
        ocrRegions = ocrResult.ocrRegions;
        setBiosOcrRegions(ocrRegions);
        cvSummary = [
          cvSummary,
          `ocrRegions=${ocrRegions.length}`,
          `ocrConfidence=${ocrResult.confidence.toFixed(2)}`,
        ].join(', ');
        if (
          ocrResult.detectedVendor
          && biosTypeSource !== 'manual'
          && !vendorDetectedRef.current
        ) {
          applyDetectedVendor(ocrResult.detectedVendor);
        }
      } catch (err) {
        console.warn('[liveGuide] OCR pipeline failed:', err);
        setBiosOcrRegions([]);
      }
    }

    try {
      setQualityText('');
      await guide.sendFrame(base64, null, cvSummary, ocrRegions, question || undefined, effectiveGoal || undefined);
      if (shouldUseInitialQuestion) initialQuestionRef.current = '';
      lastActionResultRef.current = 'none';
    } catch {
      // sendFrame 내부에서 처리됨
    }
  }, [
    guide,
    canvasRef,
    videoRef,
    cvReady,
    biosTypeSource,
    applyDetectedVendor,
    handleBiosOverlay,
    resolutionStep,
    frozenFrame,
    biosOcrRegions,
    setTaskGoal,
  ]);

  const handleQuestionSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const question = questionDraft.trim();
    if (!question) return;
    setQuestionDraft('');
    await handleManualCapture(question);
  }, [questionDraft, handleManualCapture]);

  const { currentHistRef } = useLiveFrameCapture({
    canvasRef,
    videoRef,
    cvReady,
    isSendingRef:     guide.isSendingRef,
    onFrameChange:    handleFrameChange,
    onQualityFeedback: setQualityText,
    onMetricsUpdate:  handleMetricsUpdate,
    onBiosOverlay:    handleBiosOverlay,
    onBiosVendorDetected: applyDetectedVendor,
    enableBiosVendorOcr:  !isHwRepairContext(context) && biosTypeSource !== 'manual' && !vendorDetectedRef.current,
    enableBiosPreprocess: !isHwRepairContext(context),
    enableAutoFrameSend:  false,
  });

  // ── stale guide 감지: isStreaming false 전환 시 ────────────────────────────
  useEffect(() => {
    if (guide.isStreaming) return;
    if (!guide.streamText || guide.session?.status !== 'ACTIVE') return;
    setResolutionStep('idle');
  }, [guide.isStreaming, guide.streamText, guide.session?.status]);

  useEffect(() => {
    if (guide.isStreaming) {
      setResolutionStep('hidden');
    }
  }, [guide.isStreaming]);

  useEffect(() => {
    if (guide.isStreaming || !guide.streamText.startsWith('오류가 발생했어요')) return;
    clearFrozenGuideState();
  }, [guide.isStreaming, guide.streamText, clearFrozenGuideState]);

  // ── stale guide 감지: isStreaming false 전환 시 ────────────────────────────
  useEffect(() => {
    if (guide.isStreaming) return;
    if (!capturedHistRef.current || !currentHistRef.current || !cvReady) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const score: number = compareHist(capturedHistRef.current, currentHistRef.current);
      guide.setStaleGuide(score < 0.7);
    } catch {
      // cv 아직 초기화 전
    }
    capturedHistRef.current.delete();
    capturedHistRef.current = null;
  }, [guide.isStreaming, cvReady, guide, currentHistRef]);

  // ── Task 6: 자동 vendor 감지 — isStreaming false 전환마다 streamText 파싱 ──
  useEffect(() => {
    if (guide.isStreaming) return;
    if (!guide.streamText || vendorDetectedRef.current || biosTypeSource === 'manual') return;
    const vendor = detectBiosVendor(guide.streamText);
    if (!vendor) return;
    applyDetectedVendor(vendor);
  }, [guide.isStreaming, guide.streamText, biosTypeSource, applyDetectedVendor]);

  // ── 갤러리 pending 프레임 — 세션 ACTIVE 전환 시 자동 전송 ──────────────────
  useEffect(() => {
    if (guide.session?.status !== 'ACTIVE') return;
    const pending = pendingGalleryFrameRef.current;
    if (!pending) return;
    pendingGalleryFrameRef.current = null;
    guide
      .sendFrame(pending.base64, null, pending.cvSummary, pending.ocrRegions, pending.userQuestion, pending.taskGoal)
      .then(() => {
        if (pending.userQuestion && initialQuestionRef.current === pending.userQuestion) {
          initialQuestionRef.current = '';
        }
        lastActionResultRef.current = 'none';
      })
      .catch(() => {});
  }, [guide.session?.status, guide]);

  // 컨텍스트 변경 시 vendor 감지 + AR 오버레이 + HW 안전 동의 상태 초기화
  useEffect(() => {
    vendorDetectedRef.current = false;
    setAutoVendorChip(null);
    setBiosType(null);
    setBiosTypeSource(null);
    setHwSafetyAck(false);
    setHwSafetyModalOpen(false);
    clearFrozenGuideState();
  }, [context, clearFrozenGuideState]);

  // ── 카메라 시작/종료 ─────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (cameraStartingRef.current) return;
    const existingStream = videoRef.current?.srcObject as MediaStream | null;
    if (existingStream?.active) return;

    existingStream?.getTracks().forEach(t => t.stop());
    cameraStartingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      } else {
        stream.getTracks().forEach(t => t.stop());
      }
    } catch {
      setStreamError('카메라 권한이 필요해요. 브라우저 설정에서 허용해주세요.');
    } finally {
      cameraStartingRef.current = false;
    }
  }, []);

  const stopCamera = useCallback(() => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    cameraStartingRef.current = false;
  }, []);

  // ── 앱 진입 즉시 카메라 시작 + 언마운트 정리 ──────────────────────────────
  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
      capturedHistRef.current?.delete();
      capturedHistRef.current = null;
    };
  }, [startCamera, stopCamera]);

  // ── 마운트 시 목표가 비어 있으면 목표 시트 자동 오픈 ─────────────────────
  // (Camera-First 흐름: 카메라/촬영 가이드 위에 시트가 모달로 떠 사용자 목표 수집)
  useEffect(() => {
    if (!taskGoalRef.current) setGoalSheetOpen(true);
    // 마운트 시 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 목표 시트 핸들러 (확정/시트 열기는 의존성 없음, skip은 handleAutoDiagnosisClick에 의존) ──
  const handleGoalConfirm = useCallback((goal: string) => {
    setTaskGoal(goal);
    setGoalSheetOpen(false);
    setQualityText('');
    setStreamError('');
    // 진행 중인 응답이 있으면 새 목표로 다음 캡처에 반영. 현재 세션은 유지.
  }, [setTaskGoal]);

  const openGoalSheet = useCallback(() => {
    setGoalSheetOpen(true);
  }, []);

  // ── 세션 DONE 전환 감지 — 사용자 종료/해결 확인 시에만 도달 ─────────────
  useEffect(() => {
    if (guide.session?.status === 'DONE') {
      if (isSwitchingContextRef.current) {
        isSwitchingContextRef.current = false;
        return;
      }
      stopCamera();
      setPage('done');
      clearFrozenGuideState();
    }
  }, [guide.session?.status, stopCamera, clearFrozenGuideState]);

  // ── ShootingGuide 오버레이 닫힘 → 가이드 세션 시작 ──────────────────────
  const handleGuideStart = useCallback(async () => {
    // HW 조치 모드 + 미동의 시 안전 모달 먼저 노출. 동의 후 다시 호출됨.
    if (isHwRepairContext(context) && !hwSafetyAck) {
      setHwSafetyModalOpen(true);
      return;
    }
    setShowShootingGuide(false);
    setStreamError('');
    try {
      await guide.startSession(context);
    } catch {
      setStreamError('가이드 세션 시작에 실패했어요. 잠시 후 다시 시도해주세요.');
    }
  }, [context, guide, hwSafetyAck]);

  const handleHwSafetyConfirm = useCallback(async () => {
    setHwSafetyAck(true);
    setHwSafetyModalOpen(false);
    setShowShootingGuide(false);
    setStreamError('');
    try {
      await guide.startSession(context);
    } catch {
      setStreamError('가이드 세션 시작에 실패했어요. 잠시 후 다시 시도해주세요.');
    }
  }, [context, guide]);

  // ── 컨텍스트 변경 (시트에서 선택) ───────────────────────────────────────
  const handleContextChange = useCallback((ctx: GuideContext) => {
    setContext(ctx);
    setContextSheetOpen(false);
    setQuestionDraft('');
    clearFrozenGuideState();
    setTaskGoal('');
    lastActionResultRef.current = 'none';
    if (guide.session) {
      isSwitchingContextRef.current = true;
      guide.endSession();
    }
    // 모드 전환 시 촬영 가이드 재표시 제거 — 이미 한 번 본 사용자에게 불필요
  }, [guide, setTaskGoal, clearFrozenGuideState]);

  // ── 자동 진단 진입 (목표 시트의 "잘 모르겠어요" 버튼) ─────────────────────
  const handleAutoDiagnosisClick = useCallback(async () => {
    setContextSheetOpen(false);
    setGoalSheetOpen(false);
    setTaskGoal('');

    if (context === 'GENERAL' && guide.session?.status === 'ACTIVE') {
      setQualityText('자동 진단 모드로 화면 단서를 확인하고 있어요.');
      return;
    }

    setContext('GENERAL');
    setQuestionDraft('');
    setQualityText('');
    setStreamError('');
    clearFrozenGuideState();
    lastActionResultRef.current = 'none';

    if (guide.session) {
      isSwitchingContextRef.current = true;
      guide.endSession();
    }

    if (!showShootingGuide) {
      try {
        await guide.startSession('GENERAL');
      } catch {
        setStreamError('자동 진단 세션을 시작할 수 없어요. 잠시 후 다시 시도해주세요.');
      }
    }
  }, [context, guide, showShootingGuide, clearFrozenGuideState, setTaskGoal]);

  // ── 목표 시트의 "잘 모르겠어요" → 자동 진단 폴백 (handleAutoDiagnosisClick 선언 이후 정의) ──
  const handleGoalSkip = useCallback(() => {
    setGoalSheetOpen(false);
    void handleAutoDiagnosisClick();
  }, [handleAutoDiagnosisClick]);

  const exitToParent = useCallback(() => {
    guide.endSession();
    stopCamera();
    if (onExit) {
      onExit();
    } else {
      setPage('done');
    }
    setQualityText('');
    setStreamError('');
    setQuestionDraft('');
    clearFrozenGuideState();
    lastActionResultRef.current = 'none';
    capturedHistRef.current?.delete();
    capturedHistRef.current = null;
  }, [guide, stopCamera, clearFrozenGuideState, onExit]);

  const shouldConfirmExit = useCallback(() => {
    return !showShootingGuide && guide.session?.status === 'ACTIVE';
  }, [guide.session?.status, showShootingGuide]);

  // ── 수동 종료 ────────────────────────────────────────────────────────────
  const handleEnd = useCallback(() => {
    if (shouldConfirmExit()) {
      setExitConfirmOpen(true);
      return;
    }

    exitToParent();
  }, [exitToParent, shouldConfirmExit]);

  const handleConfirmExit = useCallback(() => {
    setExitConfirmOpen(false);
    exitToParent();
  }, [exitToParent]);

  useEffect(() => {
    const handleBackRequest = () => {
      if (shouldConfirmExit()) {
        setExitConfirmOpen(true);
        return;
      }

      exitToParent();
    };

    window.addEventListener('nd-live-guide-back-request', handleBackRequest);
    return () => window.removeEventListener('nd-live-guide-back-request', handleBackRequest);
  }, [exitToParent, shouldConfirmExit]);

  const handleResolvedByUser = useCallback(() => {
    guide.endSession();
    stopCamera();
    setPage('done');
    setResolutionStep('hidden');
    setQuestionDraft('');
    clearFrozenGuideState();
    lastActionResultRef.current = 'none';
  }, [guide, stopCamera, clearFrozenGuideState]);

  const handleStillUnresolved = useCallback(() => {
    lastActionResultRef.current = 'unresolved';
    setQualityText('같은 화면 기준으로 다음 대체 단계를 다시 확인할게요.');
    void handleManualCapture('아직 해결되지 않았어요. 같은 화면에서 다음으로 확인할 단계를 알려주세요.', 'unresolved');
  }, [handleManualCapture]);

  const handleActionTried = useCallback(() => {
    lastActionResultRef.current = 'tried';
    setResolutionStep('action-done');
    setQualityText('이제 바뀐 실제 화면을 비춘 뒤 다음 화면 분석을 눌러주세요.');
    clearFrozenGuideState();
  }, [clearFrozenGuideState]);

  // ── 재시작 (완료 화면 → 카메라 화면) ──────────────────────────────────────
  const handleRestart = useCallback(() => {
    setPage('camera');
    setShowShootingGuide(true);
    setContext(initialContext);
    setQualityText('');
    setStreamError('');
    setQuestionDraft('');
    clearFrozenGuideState();
    setTaskGoal(initialQuestion.trim());
    lastActionResultRef.current = 'none';
    capturedHistRef.current?.delete();
    capturedHistRef.current = null;
    // startCamera는 page='camera' 렌더 후 아래 useEffect가 처리
    // 목표가 비어 있으면 시트 자동 오픈
    if (!initialQuestion.trim()) setGoalSheetOpen(true);
  }, [initialContext, initialQuestion, clearFrozenGuideState, setTaskGoal]);

  // page='camera'로 전환 시 카메라 재시작 (handleRestart 경로)
  useEffect(() => {
    if (page === 'camera') {
      startCamera();
    }
  // startCamera는 useCallback 메모화 — page 변화 시에만 동작
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // ── 완료 화면 ─────────────────────────────────────────────────────────────
  if (page === 'done') {
    return (
      <div className="nd-live-guide-page nd-live-guide-done">
        <div style={{ textAlign: 'center', padding: '2rem 1rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>✅</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-heading)' }}>
            가이드가 완료됐어요!
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginTop: '0.5rem', lineHeight: 1.6 }}>
            문제가 해결되지 않았다면 다시 시도해주세요.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.5rem', alignItems: 'center' }}>
            <button type="button" className="nd-guide-primary-btn" onClick={handleRestart}>
              다시 시작
            </button>
            {onExit && (
              <button type="button" className="nd-guide-secondary-btn" onClick={onExit}>
                홈으로
              </button>
            )}
            <button
              type="button"
              className="nd-guide-text-btn"
              onClick={() => {
                isSwitchingContextRef.current = true;
                guide.endSession();
                setPage('camera');
                setShowShootingGuide(true);
                setContext('GENERAL');
                setTaskGoal('');
                setGoalSheetOpen(true);
              }}
            >
              다른 작업 하기 →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 카메라 화면 ─────────────────────────────────────────────────────────
  const displayText = guide.streamText || STATIC_FIRST_GUIDE[context];
  const isWaitingForActionResult =
    !!guide.streamText
    && guide.session?.status === 'ACTIVE'
    && !guide.isStreaming
    && resolutionStep !== 'hidden';
  const nextButtonDisabled =
    guide.captureState !== 'idle'
    || guide.session?.status !== 'ACTIVE'
    || isWaitingForActionResult;
  const resolutionCaptureDisabled =
    guide.captureState !== 'idle'
    || guide.session?.status !== 'ACTIVE';
  const questionSubmitDisabled =
    guide.captureState !== 'idle'
    || guide.session?.status !== 'ACTIVE'
    || !questionDraft.trim();
  const selectedOcrTarget = guide.arTarget
    ? biosOcrRegions.find(region => region.id === guide.arTarget?.targetId) ?? null
    : null;
  const visionBboxTarget = guide.arTarget?.bbox
    ? arTargetBboxToRegion(guide.arTarget, biosVideoSize)
    : null;
  const arHintMatchedTarget = guide.arTarget && !selectedOcrTarget && !guide.isStreaming
    ? pickOcrTargetByArHint(
        biosOcrRegions,
        guide.arTarget.label,
        guide.arTarget.reason,
        guide.streamText,
        taskGoal,
        context,
      )
    : null;
  const fallbackOcrTarget = !selectedOcrTarget && !arHintMatchedTarget && !guide.isStreaming
    ? pickFallbackOcrTarget(biosOcrRegions, guide.streamText, taskGoal, context)
    : null;
  const fallbackTextRegionTarget = !selectedOcrTarget && !arHintMatchedTarget && !fallbackOcrTarget && !guide.isStreaming && guide.streamText
    ? textRegionToArTarget(biosTextRegions[0])
    : null;
  const rawActiveOcrTarget = visionBboxTarget ?? selectedOcrTarget ?? arHintMatchedTarget ?? fallbackOcrTarget ?? fallbackTextRegionTarget;
  const activeOcrTarget = rawActiveOcrTarget
    ? makeClickableTargetRegion(rawActiveOcrTarget, biosVideoSize, visionBboxTarget ? 'vision' : 'fallback')
    : null;
  const isActionMode = guide.arTarget?.mode === 'action' || isHwRepairContext(context);
  const activeTargetLabel = isActionMode
    ? (guide.arTarget?.label ?? '여기를 조치하세요!')
    : visionBboxTarget || selectedOcrTarget
      ? (guide.arTarget?.label ?? '여기를 선택')
      : arHintMatchedTarget || fallbackOcrTarget
        ? '여기를 누르세요'
        : '이 후보를 확인';
  const activeTargetLabelWidth = Math.max(118, activeOcrTarget ? Math.min(220, activeOcrTarget.bbox.w + 34) : 118);
  const activeTargetLabelPosition = activeOcrTarget && biosVideoSize
    ? getTargetLabelPosition(activeOcrTarget, biosVideoSize, activeTargetLabelWidth)
    : null;
  const visibleTextRegions: BiosTextRegion[] = SHOW_CC_DEBUG_REGIONS
    ? biosTextRegions.slice(0, activeOcrTarget ? 6 : 10)
    : [];
  const hasFrozenFrame = !!frozenFrame;

  return (
    <div className="nd-live-guide-page nd-live-guide-camera-root">

      {/* ── 상단바: [×] [현재 목표 칩] [CV상태] ── */}
      <div className="nd-live-guide-topbar">
        <button
          type="button"
          className="nd-guide-close-btn"
          onClick={handleEnd}
          aria-label="가이드 종료"
        >
          ×
        </button>
        <button
          type="button"
          className={`nd-guide-goal-chip${taskGoal ? '' : ' is-empty'}`}
          onClick={openGoalSheet}
          aria-label={taskGoal ? `현재 목표: ${taskGoal}. 탭하면 변경` : '목표 정하기'}
        >
          {taskGoal ? (
            <>
              <span className="nd-guide-goal-chip-label">목표</span>
              <span className="nd-guide-goal-chip-text">{taskGoal}</span>
              <span className="nd-guide-goal-chip-edit" aria-hidden="true">✎</span>
            </>
          ) : (
            <>
              <span className="nd-guide-goal-chip-label">+</span>
              <span className="nd-guide-goal-chip-text">목표 정하기</span>
            </>
          )}
        </button>
        <button
          type="button"
          className={`nd-cv-status${cvReady ? ' ready' : ''}${cvPanelOpen ? ' panel-open' : ''}`}
          title={cvPanelOpen ? 'CV 패널 닫기' : 'CV 파이프라인 상태 보기'}
          aria-label={cvPanelOpen ? 'CV 패널 닫기' : 'OpenCV 파이프라인 상태 보기'}
          aria-pressed={cvPanelOpen}
          onClick={() => setCvPanelOpen(v => !v)}
        >
          {cvReady ? '🔬' : '⌛'}
        </button>
      </div>
      {guide.llmMode !== 'unknown' && (
        <div
          className={`nd-llm-status-strip ${guide.llmMode}`}
          role={guide.llmMode === 'mock' ? 'alert' : 'status'}
          title={guide.llmError || (guide.llmMode === 'live' ? 'Gemini 백엔드 연결됨' : 'Mock 안내 사용 중')}
        >
          <span className="nd-llm-status-dot" aria-hidden="true" />
          <span>{guide.llmMode === 'live' ? 'Gemini 연결됨' : 'Mock 안내 중'}</span>
        </div>
      )}

      {/* ── 카메라 뷰 ── */}
      <div className="nd-camera-wrapper">
        <video
          ref={videoRef}
          className={`nd-camera-video${hasFrozenFrame ? ' is-frozen-behind' : ''}`}
          autoPlay
          playsInline
          muted
        />
        {frozenFrame && (
          <img
            className="nd-camera-frozen-frame"
            src={frozenFrame.dataUrl}
            width={frozenFrame.width}
            height={frozenFrame.height}
            alt=""
            aria-hidden="true"
          />
        )}
        {/* OpenCV 처리용 숨김 canvas */}
        <canvas ref={canvasRef} className="nd-camera-canvas" style={{ display: 'none' }} />
        {streamError && (
          <div className="nd-camera-overlay">{streamError}</div>
        )}

        <div
          className={`nd-ar-guide-frame${biosCorners ? ' detected' : ''}${hasFrozenFrame ? ' frozen' : ''}`}
          aria-hidden="true"
        >
          <span className="nd-ar-guide-label">
            {hasFrozenFrame ? 'SCREEN LOCKED' : (biosCorners ? 'SCREEN LOCKED' : 'ALIGN SCREEN')}
          </span>
        </div>

        {/* Task 7: AR 오버레이 — Hough 모서리 + 클릭 대상 OCR 타깃.
            CC 후보는 디버그 데이터로만 유지하고 기본 화면에는 렌더하지 않음.
            viewBox + preserveAspectRatio="xMidYMid slice" = CSS object-fit:cover와 동일 매핑 */}
        {biosVideoSize && (biosCorners || visibleTextRegions.length > 0 || activeOcrTarget) && (
          <svg
            className="nd-ar-overlay"
            viewBox={`0 0 ${biosVideoSize.w} ${biosVideoSize.h}`}
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
          >
            {biosCorners && (
              <>
                <polygon
                  points={biosCorners.map(([x, y]) => `${x},${y}`).join(' ')}
                  className="nd-ar-quad"
                />
                {biosCorners.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={Math.max(6, biosVideoSize.w * 0.008)} className="nd-ar-corner" />
                ))}
              </>
            )}
            {visibleTextRegions.map(region => (
              <polygon
                key={region.id}
                points={region.points.map(point => `${point[0] ?? 0},${point[1] ?? 0}`).join(' ')}
                className="nd-ar-text-region"
              />
            ))}
            {activeOcrTarget && (
              <g className={`nd-ar-selected-target${isActionMode ? ' is-action' : ''}`}>
                <line
                  x1={Math.min(biosVideoSize.w - 8, activeOcrTarget.bbox.x + activeOcrTarget.bbox.w + 28)}
                  y1={Math.max(18, activeOcrTarget.bbox.y - 18)}
                  x2={activeOcrTarget.bbox.x + activeOcrTarget.bbox.w * 0.5}
                  y2={activeOcrTarget.bbox.y + activeOcrTarget.bbox.h * 0.5}
                  className="nd-ar-target-pointer"
                />
                <circle
                  cx={activeOcrTarget.bbox.x + activeOcrTarget.bbox.w * 0.5}
                  cy={activeOcrTarget.bbox.y + activeOcrTarget.bbox.h * 0.5}
                  r={Math.max(14, Math.min(34, activeOcrTarget.bbox.h * 0.9))}
                  className="nd-ar-target-halo"
                />
                <polygon
                  points={activeOcrTarget.points.map(point => `${point[0] ?? 0},${point[1] ?? 0}`).join(' ')}
                  className="nd-ar-target-region"
                />
                <rect
                  x={activeTargetLabelPosition?.x ?? activeOcrTarget.bbox.x}
                  y={activeTargetLabelPosition?.y ?? Math.max(0, activeOcrTarget.bbox.y - 38)}
                  width={activeTargetLabelWidth}
                  height={30}
                  rx={6}
                  className="nd-ar-target-label-bg"
                />
                <text
                  x={(activeTargetLabelPosition?.x ?? activeOcrTarget.bbox.x) + 14}
                  y={(activeTargetLabelPosition?.y ?? Math.max(0, activeOcrTarget.bbox.y - 38)) + 20}
                  className="nd-ar-target-label"
                >
                  {activeTargetLabel}
                </text>
              </g>
            )}
          </svg>
        )}

        {/* CV Insight 패널 — 카메라 우상단 오버레이 */}
        {cvPanelOpen && (
          <div className="nd-cv-panel-wrapper">
            <CvInsightPanel
              metrics={cvMetrics}
              bios={biosInsight}
              cvReady={cvReady}
            />
          </div>
        )}
      </div>

      {/* ── AI 안내 + 품질 피드백 (ShootingGuide가 닫혔을 때) ── */}
      {!showShootingGuide && (
        <>
          {qualityText && (
            <div className="nd-quality-feedback">{qualityText}</div>
          )}
          <GuideBubble
            text={displayText}
            isStreaming={guide.isStreaming}
            captureState={guide.captureState}
            elapsed={guide.elapsed}
            staleGuide={guide.staleGuide}
            compact={hasFrozenFrame || !!activeOcrTarget}
          />
          {guide.session?.status === 'ACTIVE' && !activeOcrTarget && (
            <form className="nd-guide-question-form" onSubmit={handleQuestionSubmit}>
              <label className="nd-guide-question-label" htmlFor="nd-guide-question-input">
                질문하기
              </label>
              <div className="nd-guide-question-row">
                <input
                  id="nd-guide-question-input"
                  className="nd-guide-question-input"
                  type="text"
                  value={questionDraft}
                  onChange={e => setQuestionDraft(e.target.value)}
                  placeholder="지금 화면에 대해 물어보세요"
                  maxLength={160}
                  disabled={guide.captureState !== 'idle' || guide.session?.status !== 'ACTIVE'}
                />
                <button type="submit" className="nd-guide-question-submit" disabled={questionSubmitDisabled}>
                  질문
                </button>
              </div>
            </form>
          )}
          {guide.streamText && guide.session?.status === 'ACTIVE' && !guide.isStreaming && resolutionStep !== 'hidden' && (
            <div className="nd-resolution-check" role="group" aria-label="조치 결과 확인">
              {resolutionStep === 'idle' ? (
                <>
                  <span>{activeOcrTarget ? '표시된 곳을 눌렀나요?' : '안내한 조치를 해보셨나요?'}</span>
                  <button type="button" onClick={handleActionTried}>
                    {activeOcrTarget ? '눌렀어요' : '해봤어요'}
                  </button>
                  <button type="button" onClick={handleStillUnresolved}>
                    {activeOcrTarget ? '못 찾겠어요' : '아직이에요'}
                  </button>
                </>
              ) : (
                <>
                  <span>다음 화면을 분석할까요?</span>
                  <button type="button" onClick={() => handleManualCapture()} disabled={resolutionCaptureDisabled}>
                    다음 화면 분석
                  </button>
                  <button type="button" onClick={handleResolvedByUser}>
                    해결됐어요
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Task 6: 자동 vendor 감지 칩 ── */}
      {!showShootingGuide && autoVendorChip && (
        <div className="nd-vendor-chip" role="status" aria-live="polite">
          ✓ {autoVendorChip} BIOS 감지됨
        </div>
      )}

      {/* ── Thumb-zone 액션 바 (세션 ACTIVE 후 노출) ── */}
      {!showShootingGuide && (
        <div className="nd-action-bar" role="toolbar" aria-label="진단 도구">
          {/* 보조: 비프음 진단 */}
          <button
            type="button"
            className="nd-action-bar-btn"
            onClick={() => setAudioSheetOpen(true)}
            aria-label="비프음 진단 열기"
          >
            <span className="nd-action-bar-icon">🎙</span>
            <span className="nd-action-bar-label">
              {biosTypeSource === 'auto' && biosType ? `${biosType} 비프음` : '비프음'}
            </span>
          </button>

          {/* 주요: 다음 단계 (수동 캡처) */}
          <button
            type="button"
            className="nd-action-bar-btn nd-action-bar-primary"
            onClick={() => handleManualCapture()}
            disabled={nextButtonDisabled}
            aria-label="현재 화면 분석 요청"
          >
            {guide.captureState !== 'idle'
              ? <span className="nd-action-bar-analyzing">분석 중…</span>
              : <><span className="nd-action-bar-icon">✓</span><span className="nd-action-bar-label">{guide.streamText ? '다음 화면 분석' : '현재 화면 분석'}</span></>
            }
          </button>

          {/* 보조: 갤러리 사진 업로드 */}
          <button
            type="button"
            className="nd-action-bar-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={guide.captureState !== 'idle'}
            aria-label="갤러리에서 사진 선택"
          >
            <span className="nd-action-bar-icon">📁</span>
            <span className="nd-action-bar-label">갤러리</span>
          </button>
        </div>
      )}

      {/* 갤러리 파일 피커 (hidden) — capture 없으면 모바일 갤러리 열림 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleGallerySelect}
        aria-hidden="true"
      />

      {/* ── ShootingGuide 오버레이 (카메라 위 반투명, 하단 정렬) ── */}
      {showShootingGuide && (
        <div className="nd-shooting-overlay">
          <ShootingGuide onDismiss={handleGuideStart} />
        </div>
      )}

      {/* ── 목표 입력 풀업 시트 (Camera-First, 마운트 시 자동 오픈) ── */}
      {goalSheetOpen && (
        <div
          className="nd-context-sheet-backdrop"
          onClick={() => setGoalSheetOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="목표 입력"
        >
          <div
            className="nd-context-sheet"
            onClick={e => e.stopPropagation()}
          >
            <GoalInputSheet
              initialGoal={taskGoal}
              onConfirm={handleGoalConfirm}
              onSkip={handleGoalSkip}
            />
          </div>
        </div>
      )}

      {/* ── 컨텍스트 선택 풀업 시트 (완료 화면에서 "다른 작업" 진입 시) ── */}
      {contextSheetOpen && (
        <div
          className="nd-context-sheet-backdrop"
          onClick={() => setContextSheetOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="작업 선택"
        >
          <div
            className="nd-context-sheet"
            onClick={e => e.stopPropagation()}
          >
            <div className="nd-context-sheet-handle" aria-hidden="true" />
            <p className="nd-context-sheet-title">어떤 증상을 진단할까요?</p>
            <GuideContextSelector onSelect={handleContextChange} />
          </div>
        </div>
      )}

      {/* ── 비프음 진단 풀업 시트 ── */}
      {audioSheetOpen && (
        <div
          className="nd-context-sheet-backdrop"
          onClick={() => setAudioSheetOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="비프음 진단"
        >
          <div
            className="nd-context-sheet nd-audio-sheet"
            onClick={e => e.stopPropagation()}
          >
            <div className="nd-context-sheet-handle" aria-hidden="true" />
            <p className="nd-context-sheet-title">비프음 진단</p>
            {biosTypeSource === 'auto' && biosType && (
              <div className="nd-vendor-sheet-note" role="status">
                카메라 가이드에서 {biosType} BIOS로 추정했어요.
              </div>
            )}
            <BiosTypeSelector
              selected={biosType}
              onSelect={handleBiosTypeSelect}
              autoDetected={biosTypeSource === 'auto' ? biosType : null}
            />
            <div style={{ marginTop: '0.75rem' }}>
              <AudioCapture biosType={biosType} symptom="부팅 시 비프음 패턴 분석" />
            </div>
          </div>
        </div>
      )}

      {hwSafetyModalOpen && (
        <div
          className="nd-hw-safety-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nd-hw-safety-title"
        >
          <div className="nd-hw-safety-modal">
            <div className="nd-hw-safety-icon" aria-hidden="true">🛠️</div>
            <h2 id="nd-hw-safety-title">시작 전 안전 체크</h2>
            <p>물리 부품을 만지기 전에 아래 사항을 꼭 확인해주세요.</p>
            <ul className="nd-hw-safety-list">
              <li><strong>전원 코드</strong>를 콘센트에서 완전히 분리했어요.</li>
              <li>본체 전원 버튼을 5초 누르고 있어 <strong>잔류 전류</strong>를 빼냈어요.</li>
              <li>금속 부분을 만져 <strong>정전기</strong>를 방전했어요 (또는 손목 접지띠 착용).</li>
              <li>부품 <strong>금색 단자</strong>는 손가락으로 직접 만지지 않을 거예요.</li>
            </ul>
            <p className="nd-hw-safety-note">
              ⚠️ 잘 모르겠으면 수리 기사 상담을 권장해요. 잘못 만지면 부품이 영구 손상될 수 있어요.
            </p>
            <div className="nd-hw-safety-actions">
              <button
                type="button"
                className="nd-hw-safety-cancel"
                onClick={() => {
                  setHwSafetyModalOpen(false);
                  setContext('GENERAL');
                }}
              >
                다른 진단 하기
              </button>
              <button
                type="button"
                className="nd-hw-safety-confirm"
                onClick={handleHwSafetyConfirm}
              >
                모두 확인했어요
              </button>
            </div>
          </div>
        </div>
      )}

      {exitConfirmOpen && (
        <div
          className="nd-exit-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nd-exit-confirm-title"
        >
          <div className="nd-exit-confirm">
            <h2 id="nd-exit-confirm-title">진단을 종료할까요?</h2>
            <p>현재 안내 내용과 카메라 분석 흐름이 종료됩니다.</p>
            <div className="nd-exit-confirm-actions">
              <button
                type="button"
                className="nd-exit-confirm-secondary"
                onClick={() => setExitConfirmOpen(false)}
              >
                계속 진단하기
              </button>
              <button
                type="button"
                className="nd-exit-confirm-primary"
                onClick={handleConfirmExit}
              >
                홈으로 나가기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
