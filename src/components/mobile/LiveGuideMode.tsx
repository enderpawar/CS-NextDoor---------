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
import { Camera } from 'lucide-react';
import '../../styles/mobile.css';
import { useOpenCV }                         from '../../hooks/useOpenCV';
import { useGeminiLiveGuide }                from '../../hooks/useGeminiLiveGuide';
import { useLiveFrameCapture }               from '../../hooks/useLiveFrameCapture';
import type { BiosArOverlay, CvFrameInsightMetrics } from '../../hooks/useLiveFrameCapture';
import {
  DIAGNOSTIC_CLIP_LONG_PRESS_MS,
  buildDiagnosticClipSummary,
  shouldStartDiagnosticClip,
  useDiagnosticClipCapture,
} from '../../hooks/useDiagnosticClipCapture';
import GuideContextSelector                  from './GuideContextSelector';
import GoalInputSheet                        from './GoalInputSheet';
import GuideBubble                           from './GuideBubble';
import ShootingGuide                         from './ShootingGuide';
import CvInsightPanel                        from './CvInsightPanel';
import type { GuideArTarget, GuideContext, BiosType, GuideOcrRegion, CvFrameInput } from '../../types';
import { isHwRepairContext } from '../../types';
import { compareHist }                       from '../../lib/cv/changeDetection';
import { analyzeFrame }                      from '../../lib/cv/frameMetrics';
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
const GALLERY_VIDEO_MAX_DURATION_SEC = 15;
const GALLERY_VIDEO_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const GALLERY_VIDEO_SAMPLE_FPS = 4;
const GALLERY_VIDEO_MAX_ANALYSIS_SIDE = 640;
const GALLERY_VIDEO_REPRESENTATIVE_MAX_SIDE = 1280;   // 대표 프레임 재캡처 해상도 (Gemini OCR 품질 보존)
const GALLERY_VIDEO_SEEK_TIMEOUT_MS = 2500;            // seek 무한 대기 방지
const GALLERY_VIDEO_LOAD_TIMEOUT_MS = 8000;            // loadedmetadata 무한 대기 방지
const GALLERY_REPRESENTATIVE_JPEG_QUALITY = 0.85;      // 이미지 업로드 경로와 통일

type PageState = 'camera' | 'done';
type ActionResult = 'none' | 'tried' | 'unresolved';

interface FrozenFrame {
  dataUrl: string;
  width: number;
  height: number;
}

interface GalleryVideoAnalysis {
  base64: string;
  rgba: ImageData;
  width: number;
  height: number;
  cvSummary: string;
}

interface GalleryFrameAnalysis {
  timestampMs: number;
  brightnessMean: number;
  qualityScore: number;
  sceneChangeScore: number;
}

interface DrawnVideoFrame {
  imageData: ImageData;
  width: number;
  height: number;
}

interface Props {
  initialContext?: GuideContext;
  initialQuestion?: string;
  initialInputMode?: 'camera' | 'gallery';
  initialGalleryFiles?: File[];
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

function isLikelyImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(avif|gif|jpe?g|png|webp)$/i.test(file.name);
}

function isLikelyVideoFile(file: File) {
  return file.type.startsWith('video/') || /\.(m4v|mov|mp4|webm)$/i.test(file.name);
}

function waitForMediaEvent(target: HTMLMediaElement, eventName: string, timeoutMs?: number) {
  return new Promise<void>((resolve, reject) => {
    let timer: number | null = null;
    const cleanup = () => {
      target.removeEventListener(eventName, handleEvent);
      target.removeEventListener('error', handleError);
      if (timer !== null) window.clearTimeout(timer);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`media ${eventName} failed`));
    };
    target.addEventListener(eventName, handleEvent, { once: true });
    target.addEventListener('error', handleError, { once: true });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`media ${eventName} timeout`));
      }, timeoutMs);
    }
  });
}

async function seekVideo(
  video: HTMLVideoElement,
  timeSec: number,
  timeoutMs: number = GALLERY_VIDEO_SEEK_TIMEOUT_MS,
) {
  const target = Math.min(Math.max(0, timeSec), Math.max(0, video.duration - 0.05));
  if (Math.abs(video.currentTime - target) < 0.01) return;
  const wait = waitForMediaEvent(video, 'seeked', timeoutMs);
  video.currentTime = target;
  await wait;
}

/** 비디오 현재 프레임을 캔버스에 그리고 ImageData를 반환. ImageData.data를 그대로 사용 (복사 없음). */
function drawVideoToCanvas(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxSide: number,
): DrawnVideoFrame | null {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { imageData, width: canvas.width, height: canvas.height };
}

/**
 * 갤러리 동영상 분석.
 *
 * 메모리·연산 효율을 위해 두 패스로 동작:
 *  - 1차: 저해상도(640px)로 모든 샘플을 순회하며 메트릭만 누적 (이전 히스토그램을 캐시해 analyzeFrame 1회 호출).
 *         ImageData는 매 반복마다 폐기 — 60프레임 동시 보관으로 인한 100MB+ 메모리 폭증 방지.
 *  - 2차: 품질×0.6 + 장면변화×0.4 가중합으로 선정한 대표 시점을 재seek해 고해상도(1280px)로 단 1장 캡처.
 *         Gemini Vision에 전달되는 해상도가 이미지 업로드 경로와 동일해짐.
 *
 * 모든 seek/load는 타임아웃이 걸려 있어 코덱 이슈로 영원히 멈추지 않음.
 */
async function analyzeGalleryVideo(file: File): Promise<GalleryVideoAnalysis> {
  if (file.size > GALLERY_VIDEO_MAX_SIZE_BYTES) {
    throw new Error('video-file-too-large');
  }

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(file);

  try {
    video.src = url;
    try {
      await waitForMediaEvent(video, 'loadedmetadata', GALLERY_VIDEO_LOAD_TIMEOUT_MS);
    } catch {
      throw new Error('video-codec-unsupported');
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('video-duration-unavailable');
    }
    if (video.duration > GALLERY_VIDEO_MAX_DURATION_SEC) {
      throw new Error('video-too-long');
    }
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error('video-codec-unsupported');
    }

    // ── Pass 1: 메트릭만 누적 (ImageData 비보관, 이전 히스토그램 캐시) ──
    const analysisCanvas = document.createElement('canvas');
    const sampleCount = Math.max(3, Math.floor(video.duration * GALLERY_VIDEO_SAMPLE_FPS));
    const analyses: GalleryFrameAnalysis[] = [];
    let prevHist: number[] | undefined;

    for (let index = 0; index < sampleCount; index += 1) {
      const timeSec = sampleCount === 1
        ? 0
        : (index / (sampleCount - 1)) * Math.max(0, video.duration - 0.05);
      try {
        await seekVideo(video, timeSec);
      } catch {
        continue;   // seek 타임아웃 → 해당 샘플 건너뜀
      }
      const drawn = drawVideoToCanvas(video, analysisCanvas, GALLERY_VIDEO_MAX_ANALYSIS_SIDE);
      if (!drawn) continue;

      const frame: CvFrameInput = {
        id: `gallery-video-${Math.round(timeSec * 1000)}`,
        width: drawn.width,
        height: drawn.height,
        data: drawn.imageData.data,   // 복사 없이 참조 — 이 반복 끝나면 GC
        timestampMs: timeSec * 1000,
      };
      const metrics = analyzeFrame(frame, prevHist);
      analyses.push({
        timestampMs: timeSec * 1000,
        brightnessMean: metrics.brightnessMean,
        qualityScore: metrics.qualityScore,
        sceneChangeScore: Math.max(0, Math.min(1, metrics.sceneChangeScore ?? 0)),
      });
      prevHist = metrics.histogram;
    }

    // 3장 미만이면 통계가 의미 없음 — 단 1장이라도 살아남았는데 sampleCount가 작았다면(<3) 그대로 진행하지 않음
    if (analyses.length < 3) throw new Error('video-no-frames');

    // ── 대표 프레임 선택: 품질 + 장면변화 가중합 (Codex 버전의 "최대 밝기 델타" 휴리스틱 교체) ──
    // 첫 프레임은 sceneChangeScore=0이라 품질 점수만 반영됨.
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < analyses.length; i += 1) {
      const a = analyses[i]!;
      const score = a.qualityScore * 0.6 + a.sceneChangeScore * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const repTimeSec = analyses[bestIndex]!.timestampMs / 1000;

    // ── Pass 2: 대표 시점을 고해상도로 재캡처 ──
    try {
      await seekVideo(video, repTimeSec);
    } catch {
      throw new Error('video-no-representative');
    }
    const repCanvas = document.createElement('canvas');
    const repDrawn = drawVideoToCanvas(video, repCanvas, GALLERY_VIDEO_REPRESENTATIVE_MAX_SIDE);
    if (!repDrawn) throw new Error('video-no-representative');
    const repBase64 = repCanvas.toDataURL('image/jpeg', GALLERY_REPRESENTATIVE_JPEG_QUALITY).split(',')[1] ?? '';
    if (!repBase64) throw new Error('video-no-representative');

    // ── 요약 통계 ──
    const brightnessValues = analyses.map(a => a.brightnessMean);
    const sceneChangeScores = analyses.map(a => a.sceneChangeScore);
    const brightnessDeltas = brightnessValues
      .slice(1)
      .map((value, idx) => Math.abs(value - (brightnessValues[idx] ?? value)));
    const brightnessDeltaMax = brightnessDeltas.length > 0 ? Math.max(...brightnessDeltas) : 0;
    const changedFrames = brightnessDeltas.filter(
      delta => delta >= Math.max(0.06, brightnessDeltaMax * 0.55),
    ).length;

    const cvSummary = [
      buildDiagnosticClipSummary({
        durationMs: video.duration * 1000,
        sampledFrames: analyses.length,
        selectedFrames: Math.max(1, changedFrames),
        brightnessValues,
        sceneChangeScores,
        audioAvailable: false,
        audioSamples: [],
      }).replace('captureSource=clip', 'captureSource=galleryVideo'),
      `videoDurationMs=${Math.round(video.duration * 1000)}`,
      `videoSampleFps=${GALLERY_VIDEO_SAMPLE_FPS}`,
      `selectedFrameAtMs=${Math.round(repTimeSec * 1000)}`,
      `sourceMimeType=${file.type || 'unknown'}`,
    ].join(', ');

    return {
      base64: repBase64,
      rgba: repDrawn.imageData,
      width: repDrawn.width,
      height: repDrawn.height,
      cvSummary,
    };
  } finally {
    URL.revokeObjectURL(url);
    // 디코더/스트림 해제 — 안 풀어주면 메모리에 남아있을 수 있음
    video.removeAttribute('src');
    try { video.load(); } catch { /* noop */ }
  }
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

export default function LiveGuideMode({ initialContext = 'GENERAL', initialQuestion = '', initialInputMode = 'camera', initialGalleryFiles = [], onExit }: Props) {
  const [page,              setPage]             = useState<PageState>('camera');
  const [context,           setContext]          = useState<GuideContext>(initialContext);
  const [showShootingGuide, setShowShootingGuide] = useState(initialInputMode === 'camera');
  const [contextSheetOpen,  setContextSheetOpen] = useState(false);
  const [goalSheetOpen,     setGoalSheetOpen]    = useState(false);
  const [taskGoal,          setTaskGoalState]    = useState(initialQuestion.trim());
  const [qualityText,       setQualityText]      = useState('');
  const [streamError,       setStreamError]      = useState('');
  const [resolutionStep,    setResolutionStep]   = useState<'idle' | 'action-done' | 'hidden'>('hidden');
  const [questionDraft,     setQuestionDraft]    = useState(initialQuestion);
  const [reportDraft,       setReportDraft]      = useState('');
  const [exitConfirmOpen,   setExitConfirmOpen]  = useState(false);
  const [hwSafetyAck,       setHwSafetyAck]      = useState(false);  // HW 조치 안전 모달 1회 동의
  const [hwSafetyModalOpen, setHwSafetyModalOpen] = useState(false);

  // CV Insight 패널 상태 (Task 3)
  const [cvPanelOpen,   setCvPanelOpen]   = useState(() => {
    try {
      return localStorage.getItem('nd-cv-panel-open') === '1';
    } catch {
      return false;
    }
  });
  const [cvMetrics,     setCvMetrics]     = useState<CvFrameInsightMetrics | null>(null);
  const [biosInsight,   setBiosInsight]   = useState<{ rectified: boolean; textRegions: number; processMs: number } | null>(null);

  // Thumb-zone 액션 바 상태 (Task 5)
  const [biosType,       setBiosType]       = useState<BiosType | null>(null);
  const [biosTypeSource, setBiosTypeSource] = useState<'auto' | null>(null);
  const [clipCaptureState, setClipCaptureState] = useState<'idle' | 'arming' | 'recording' | 'analyzing'>('idle');

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
  const initialGalleryFilesHandledRef = useRef(false);
  const isSwitchingContextRef = useRef(false);
  const cameraStartingRef     = useRef(false);
  const smoothedCornersRef    = useRef<number[][] | null>(null);
  const overlaySizeRef        = useRef<{ w: number; h: number } | null>(null);
  const lastQualityFeedbackRef = useRef('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capturedHistRef = useRef<any>(null);
  const initialQuestionRef = useRef(initialQuestion.trim());
  const taskGoalRef = useRef(initialQuestion.trim());
  const capturePointerRef = useRef<{
    pointerId: number;
    startedAt: number;
    longPressTimer: number | null;
    clipStarted: boolean;
    finished: boolean;
  } | null>(null);

  /** taskGoal state + ref를 함께 갱신 — 비동기 콜백은 ref.current를, 렌더링은 state를 사용 */
  const setTaskGoal = useCallback((value: string) => {
    const trimmed = value.trim();
    taskGoalRef.current = trimmed;
    setTaskGoalState(trimmed);
  }, []);

  const lastActionResultRef = useRef<ActionResult>('none');
  const pendingGalleryFramesRef = useRef<{
    base64: string;
    cvSummary: string;
    ocrRegions: GuideOcrRegion[];
    userQuestion?: string;
    taskGoal?: string;
    displayFrame: FrozenFrame;
    overlay: {
      corners: number[][] | null;
      textRegions: BiosTextRegion[];
      videoSize: { w: number; h: number };
      biosInsight: { rectified: boolean; textRegions: number; processMs: number } | null;
    };
  }[]>([]);
  // 갤러리 업로드 중복 실행 가드 — 동영상 분석이 수초 걸리는 동안 두 번째 파일 선택 차단
  const galleryProcessingRef = useRef(false);
  const gallerySessionStartRequestedRef = useRef(false);
  const [galleryProcessing, setGalleryProcessing] = useState(false);

  const { cvReady } = useOpenCV();
  const guide = useGeminiLiveGuide();
  const diagnosticClip = useDiagnosticClipCapture({
    videoRef,
    canvasRef,
    cvReady,
    context,
  });

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

  const applyDetectedVendor = useCallback((vendor: BiosType) => {
    if (vendorDetectedRef.current) return;
    vendorDetectedRef.current = true;
    setBiosType(vendor);
    setBiosTypeSource('auto');
    setAutoVendorChip(vendor);
    window.setTimeout(() => setAutoVendorChip(null), 4000);
  }, []);

  const isWaitingForActionResult =
    !!guide.streamText
    && guide.session?.status === 'ACTIVE'
    && !guide.isStreaming
    && resolutionStep !== 'hidden';
  const nextButtonDisabled =
    guide.captureState !== 'idle'
    || clipCaptureState === 'analyzing'
    || guide.session?.status !== 'ACTIVE'
    || isWaitingForActionResult;
  const resolutionCaptureDisabled =
    guide.captureState !== 'idle'
    || clipCaptureState !== 'idle'
    || guide.session?.status !== 'ACTIVE';
  const questionSubmitDisabled =
    guide.captureState !== 'idle'
    || clipCaptureState !== 'idle'
    || guide.session?.status !== 'ACTIVE'
    || !questionDraft.trim();

  useEffect(() => {
    try {
      localStorage.setItem('nd-cv-panel-open', cvPanelOpen ? '1' : '0');
    } catch {}
  }, [cvPanelOpen]);

  // ── 갤러리 이미지/짧은 동영상 업로드 → CV 전처리 → Gemini 전송 ───────────
  const processGalleryFile = useCallback(
    async (file: File) => {
      // 동시 실행 가드 — 동영상 분석이 수초 걸리는 동안 두 번째 호출 차단
      if (galleryProcessingRef.current) return;

      const isVideo = isLikelyVideoFile(file);
      const isImage = isLikelyImageFile(file);
      if (!isImage && !isVideo) {
        setStreamError('사진이나 15초 이하의 동영상만 선택할 수 있어요.');
        return;
      }

      galleryProcessingRef.current = true;
      setGalleryProcessing(true);
      setStreamError('');
      setQualityText(isVideo ? '동영상에서 화면 변화가 큰 장면을 찾는 중...' : '');

      try {
        let base64 = '';
        let rgba: ImageData;
        let width = 0;
        let height = 0;
        let cvSummary = '';
        let galleryCorners: number[][] | null = null;
        let galleryTextRegions: BiosTextRegion[] = [];
        let galleryBiosInsight: { rectified: boolean; textRegions: number; processMs: number } | null = null;

        if (isVideo) {
          try {
            const result = await analyzeGalleryVideo(file);
            base64 = result.base64;
            rgba = result.rgba;
            width = result.width;
            height = result.height;
            cvSummary = result.cvSummary;
          } catch (err) {
            const message = err instanceof Error ? err.message : '';
            if (message === 'video-too-long') {
              setStreamError('동영상은 15초 이하만 분석할 수 있어요.');
            } else if (message === 'video-file-too-large') {
              setStreamError('동영상은 50MB 이하만 분석할 수 있어요.');
            } else if (message === 'video-codec-unsupported' || message === 'video-duration-unavailable') {
              setStreamError('이 동영상 코덱은 브라우저에서 열 수 없어요. mp4(h.264)로 다시 저장해주세요.');
            } else {
              setStreamError('동영상에서 분석할 화면 변화를 찾지 못했어요.');
            }
            return;
          }
        } else {
          // 이미지 로드
          const img = new Image();
          const url = URL.createObjectURL(file);
          try {
            await new Promise<void>((resolve, reject) => {
              img.onload  = () => resolve();
              img.onerror = () => reject(new Error('image-load-failed'));
              img.src = url;
            });
          } catch {
            setStreamError('이미지를 불러올 수 없어요.');
            return;
          } finally {
            URL.revokeObjectURL(url);
          }

          // off-screen canvas에 그리기 — 최대 1280px로 리사이즈 (rAF 루프와 canvasRef 충돌 방지)
          const MAX_SIDE = GALLERY_VIDEO_REPRESENTATIVE_MAX_SIDE;
          const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          const offCanvas = document.createElement('canvas');
          offCanvas.width  = Math.round(img.naturalWidth  * scale);
          offCanvas.height = Math.round(img.naturalHeight * scale);
          const ctx = offCanvas.getContext('2d');
          if (!ctx) {
            setStreamError('이미지를 처리할 수 없어요.');
            return;
          }
          ctx.drawImage(img, 0, 0, offCanvas.width, offCanvas.height);
          rgba = ctx.getImageData(0, 0, offCanvas.width, offCanvas.height);
          base64 = offCanvas.toDataURL('image/jpeg', GALLERY_REPRESENTATIVE_JPEG_QUALITY).split(',')[1] ?? '';
          width = offCanvas.width;
          height = offCanvas.height;
          cvSummary = '';
        }

        const displayFrame = {
          dataUrl: `data:image/jpeg;base64,${base64}`,
          width,
          height,
        };
        setFrozenFrame(displayFrame);

        const initialQuestionForFrame = !guide.streamText ? initialQuestionRef.current : '';
        if (initialQuestionForFrame && !taskGoalRef.current) setTaskGoal(initialQuestionForFrame);
        cvSummary = [
          cvSummary,
          'galleryUpload=true',
          isVideo ? 'galleryUploadType=video' : 'galleryUploadType=image',
          initialQuestionForFrame ? 'userQuestion=true' : 'userQuestion=false',
          initialQuestionForFrame ? 'guidePhase=question-initial' : 'guidePhase=initial',
          `previousActionResult=${lastActionResultRef.current}`,
        ].filter(Boolean).join(', ');

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
            galleryCorners = preprocessed.corners;
            galleryTextRegions = preprocessed.textRegions;
            galleryBiosInsight = {
              rectified:   preprocessed.rectified,
              textRegions: preprocessed.textRegionCount,
              processMs:   Math.round(preprocessed.processingMs),
            };
            handleBiosOverlay({
              corners: preprocessed.corners,
              textRegions: preprocessed.textRegions,
              videoW: width,
              videoH: height,
            });
            setBiosInsight(galleryBiosInsight);
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

        pendingGalleryFramesRef.current.push({
          base64,
          cvSummary,
          ocrRegions: galleryOcrRegions,
          userQuestion: initialQuestionForFrame || undefined,
          taskGoal: taskGoalRef.current || initialQuestionForFrame || undefined,
          displayFrame,
          overlay: {
            corners: galleryCorners,
            textRegions: galleryTextRegions,
            videoSize: { w: width, h: height },
            biosInsight: galleryBiosInsight,
          },
        });

        if (guide.session?.status === 'ACTIVE') {
          // 이미 세션 활성 → 즉시 전송
          const pending = pendingGalleryFramesRef.current.shift();
          if (!pending) return;
          setFrozenFrame(pending.displayFrame);
          setBiosCorners(pending.overlay.corners);
          setBiosTextRegions(pending.overlay.textRegions);
          setBiosVideoSize(pending.overlay.videoSize);
          setBiosInsight(pending.overlay.biosInsight);
          setBiosOcrRegions(pending.ocrRegions);
          try {
            await guide.sendFrame(
              pending.base64,
              null,
              pending.cvSummary,
              pending.ocrRegions,
              pending.userQuestion,
              pending.taskGoal,
            );
            if (pending.userQuestion) initialQuestionRef.current = '';
            lastActionResultRef.current = 'none';
          } catch { /* 내부 처리 */ }
        } else {
          // 세션 없음 → ShootingGuide 닫고 자동 시작 (완료 후 pendingGalleryFrameRef useEffect가 전송)
          setShowShootingGuide(false);
          if (!gallerySessionStartRequestedRef.current) {
            gallerySessionStartRequestedRef.current = true;
            try {
              await guide.startSession(context);
            } catch {
              gallerySessionStartRequestedRef.current = false;
              setStreamError('가이드 세션을 시작할 수 없어요.');
              pendingGalleryFramesRef.current = [];
            }
          }
        }
      } finally {
        setQualityText('');
        galleryProcessingRef.current = false;
        setGalleryProcessing(false);
      }
    },
    [cvReady, guide, context, handleBiosOverlay, applyDetectedVendor, setTaskGoal],
  );

  const processGalleryFiles = useCallback(
    async (files: File[]) => {
      const validFiles = files.filter(file => isLikelyImageFile(file) || isLikelyVideoFile(file));
      if (!validFiles.length) {
        setStreamError('사진이나 15초 이하의 동영상만 선택할 수 있어요.');
        return;
      }

      setQualityText(validFiles.length > 1 ? `${validFiles.length}개 파일을 순서대로 분석할게요.` : '');
      for (const file of validFiles) {
        await processGalleryFile(file);
      }
    },
    [processGalleryFile],
  );

  const handleGallerySelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';   // 동일 파일 재선택 허용
      if (files.length) void processGalleryFiles(files);
    },
    [processGalleryFiles],
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
        if (ocrResult.detectedVendor && !vendorDetectedRef.current) {
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
    applyDetectedVendor,
    handleBiosOverlay,
    resolutionStep,
    frozenFrame,
    biosOcrRegions,
    setTaskGoal,
  ]);

  const finishDiagnosticClipCapture = useCallback(async (fallbackToPhoto = true) => {
    const pointerState = capturePointerRef.current;
    if (pointerState) pointerState.finished = true;
    setClipCaptureState('analyzing');
    setQualityText('깜빡임/소리 분석 중...');

    const result = await diagnosticClip.finishClipCapture();
    if (!result) {
      setClipCaptureState('idle');
      capturePointerRef.current = null;
      setQualityText('클립이 너무 짧아 사진 1장으로 분석할게요.');
      if (fallbackToPhoto) await handleManualCapture();
      return;
    }

    if (guide.isSendingRef.current || guide.session?.status !== 'ACTIVE') {
      setClipCaptureState('idle');
      capturePointerRef.current = null;
      return;
    }

    setFrozenFrame({
      dataUrl: `data:image/jpeg;base64,${result.frameBase64}`,
      width: result.width,
      height: result.height,
    });
    if (result.ocrRegions) setBiosOcrRegions(result.ocrRegions);

    const shouldUseInitialQuestion = !guide.streamText && !!initialQuestionRef.current;
    const question = shouldUseInitialQuestion ? initialQuestionRef.current : '';
    const effectiveGoal = taskGoalRef.current || question;
    if (effectiveGoal && !taskGoalRef.current) setTaskGoal(effectiveGoal);

    try {
      await guide.sendFrame(
        result.frameBase64,
        null,
        [
          result.cvSummary,
          question ? 'userQuestion=true' : 'userQuestion=false',
          question
            ? (guide.streamText ? 'guidePhase=question-followup' : 'guidePhase=question-initial')
            : (guide.streamText ? 'guidePhase=followup' : 'guidePhase=initial'),
          `previousActionResult=${lastActionResultRef.current}`,
        ].join(', '),
        result.ocrRegions,
        question || undefined,
        effectiveGoal || undefined,
      );
      if (shouldUseInitialQuestion) initialQuestionRef.current = '';
      lastActionResultRef.current = 'none';
      setQualityText(result.qualityFeedback ?? '');
    } catch {
      // sendFrame 내부에서 처리됨
    } finally {
      setClipCaptureState('idle');
      capturePointerRef.current = null;
    }
  }, [diagnosticClip, guide, handleManualCapture, setTaskGoal]);

  const handleCapturePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (nextButtonDisabled || guide.isSendingRef.current || guide.session?.status !== 'ACTIVE') return;
    if (clipCaptureState !== 'idle') return;
    if (capturePointerRef.current) return;

    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pointerState = {
      pointerId: e.pointerId,
      startedAt: performance.now(),
      longPressTimer: null as number | null,
      clipStarted: false,
      finished: false,
    };
    capturePointerRef.current = pointerState;
    setClipCaptureState('arming');

    pointerState.longPressTimer = window.setTimeout(() => {
      const activeState = capturePointerRef.current;
      if (!activeState || activeState.pointerId !== e.pointerId || activeState.finished) return;
      activeState.clipStarted = true;
      setClipCaptureState('recording');
      setQualityText('촬영 중');
      void diagnosticClip.beginClipCapture(() => {
        void finishDiagnosticClipCapture(false);
      }).then(started => {
        const currentState = capturePointerRef.current;
        if (started || !currentState || currentState.pointerId !== e.pointerId || currentState.finished) return;
        currentState.finished = true;
        capturePointerRef.current = null;
        setClipCaptureState('idle');
        setQualityText('카메라가 준비되지 않았어요. 다시 시도해주세요.');
      });
    }, DIAGNOSTIC_CLIP_LONG_PRESS_MS);
  }, [clipCaptureState, diagnosticClip, finishDiagnosticClipCapture, guide.isSendingRef, guide.session?.status, nextButtonDisabled]);

  const endCapturePointer = useCallback(async (
    e: React.PointerEvent<HTMLButtonElement>,
    mode: 'up' | 'cancel',
  ) => {
    const pointerState = capturePointerRef.current;
    if (!pointerState || pointerState.pointerId !== e.pointerId || pointerState.finished) return;

    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (pointerState.longPressTimer !== null) {
      window.clearTimeout(pointerState.longPressTimer);
      pointerState.longPressTimer = null;
    }

    const elapsedMs = performance.now() - pointerState.startedAt;
    if (pointerState.clipStarted || shouldStartDiagnosticClip(elapsedMs)) {
      pointerState.clipStarted = true;
      await finishDiagnosticClipCapture(mode === 'up');
      return;
    }

    diagnosticClip.cancelClipCapture();
    capturePointerRef.current = null;
    setClipCaptureState('idle');
    if (mode === 'up') await handleManualCapture();
  }, [diagnosticClip, finishDiagnosticClipCapture, handleManualCapture]);

  useEffect(() => {
    return () => {
      const pointerState = capturePointerRef.current;
      if (pointerState?.longPressTimer != null) window.clearTimeout(pointerState.longPressTimer);
      diagnosticClip.cancelClipCapture();
    };
  }, [diagnosticClip]);

  const handleQuestionSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const question = questionDraft.trim();
    if (!question) return;
    setQuestionDraft('');
    await handleManualCapture(question);
  }, [questionDraft, handleManualCapture]);

  const handleQualityFeedback = useCallback((message: string) => {
    if (guide.captureState !== 'idle' || clipCaptureState !== 'idle' || galleryProcessingRef.current) return;

    if (message) {
      lastQualityFeedbackRef.current = message;
      setQualityText(message);
      return;
    }

    const lastFeedback = lastQualityFeedbackRef.current;
    if (!lastFeedback) return;
    lastQualityFeedbackRef.current = '';
    setQualityText(current => (current === lastFeedback ? '' : current));
  }, [clipCaptureState, guide.captureState]);

  const cvProcessingPaused =
    showShootingGuide
    || goalSheetOpen
    || contextSheetOpen
    || hwSafetyModalOpen
    || exitConfirmOpen
    || page !== 'camera';

  const { currentHistRef } = useLiveFrameCapture({
    canvasRef,
    videoRef,
    cvReady,
    isSendingRef:     guide.isSendingRef,
    onFrameChange:    handleFrameChange,
    onQualityFeedback: handleQualityFeedback,
    onMetricsUpdate:  handleMetricsUpdate,
    onBiosOverlay:    handleBiosOverlay,
    onBiosVendorDetected: applyDetectedVendor,
    enableBiosVendorOcr:  !isHwRepairContext(context) && !vendorDetectedRef.current,
    enableBiosPreprocess: !isHwRepairContext(context),
    enableAutoFrameSend:  false,
    paused:               cvProcessingPaused,
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
    if (!guide.streamText || vendorDetectedRef.current) return;
    const vendor = detectBiosVendor(guide.streamText);
    if (!vendor) return;
    applyDetectedVendor(vendor);
  }, [guide.isStreaming, guide.streamText, applyDetectedVendor]);

  // ── 갤러리 pending 프레임 — 세션 ACTIVE 전환 시 자동 전송 ──────────────────
  useEffect(() => {
    if (guide.session?.status !== 'ACTIVE') return;
    if (!pendingGalleryFramesRef.current.length) return;

    let cancelled = false;
    const sendPendingFrames = async () => {
      while (!cancelled && pendingGalleryFramesRef.current.length > 0) {
        const pending = pendingGalleryFramesRef.current.shift();
        if (!pending) return;
        setFrozenFrame(pending.displayFrame);
        setBiosCorners(pending.overlay.corners);
        setBiosTextRegions(pending.overlay.textRegions);
        setBiosVideoSize(pending.overlay.videoSize);
        setBiosInsight(pending.overlay.biosInsight);
        setBiosOcrRegions(pending.ocrRegions);
        await guide.sendFrame(pending.base64, null, pending.cvSummary, pending.ocrRegions, pending.userQuestion, pending.taskGoal);
        if (pending.userQuestion && initialQuestionRef.current === pending.userQuestion) {
          initialQuestionRef.current = '';
        }
        if (guide.isSendingRef.current) return;
        lastActionResultRef.current = 'none';
      }
    };

    void sendPendingFrames().catch(() => {});
    return () => {
      cancelled = true;
    };
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
      // 카메라 + 마이크 권한을 한 번에 요청 — 이후 비프음/클립 캡처 시 추가 프롬프트 없이 사용 가능.
      // 마이크 거부 시 비디오만으로 진행 (graceful fallback).
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      }

      // 마이크 트랙은 즉시 정리 — 권한 grant는 origin에 유지되어 이후 getUserMedia({audio})가 재프롬프트 없이 통과.
      stream.getAudioTracks().forEach(t => t.stop());
      const videoOnly = new MediaStream(stream.getVideoTracks());

      if (videoRef.current) {
        videoRef.current.srcObject = videoOnly;
        await videoRef.current.play();
      } else {
        videoOnly.getTracks().forEach(t => t.stop());
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
    if (initialInputMode === 'gallery') return;
    startCamera();
    return () => {
      stopCamera();
      capturedHistRef.current?.delete();
      capturedHistRef.current = null;
    };
  }, [initialInputMode, startCamera, stopCamera]);

  useEffect(() => {
    return () => {
      capturedHistRef.current?.delete();
      capturedHistRef.current = null;
    };
  }, []);

  // ── 마운트 시 목표가 비어 있으면 목표 시트 자동 오픈 ─────────────────────
  // (Camera-First 흐름: 카메라/촬영 가이드 위에 시트가 모달로 떠 사용자 목표 수집)
  useEffect(() => {
    if (initialInputMode === 'gallery') return;
    if (!taskGoalRef.current) setGoalSheetOpen(true);
    // 마운트 시 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialInputMode !== 'gallery') return;
    if (initialGalleryFiles.length > 0) return;
    if (guide.session) return;

    setShowShootingGuide(false);
    setGoalSheetOpen(false);
    setStreamError('');
    setQualityText('저장된 사진이나 15초 이하 동영상을 선택해주세요.');
    guide.startSession(context).catch(() => {
      setStreamError('가이드 세션을 시작할 수 없어요. 잠시 후 다시 시도해주세요.');
    });
    // 갤러리 진입 시 세션 1회 자동 시작
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInputMode, initialGalleryFiles.length]);

  useEffect(() => {
    if (initialInputMode !== 'gallery') return;
    if (!initialGalleryFiles.length || initialGalleryFilesHandledRef.current) return;

    initialGalleryFilesHandledRef.current = true;
    setShowShootingGuide(false);
    setGoalSheetOpen(false);
    void processGalleryFiles(initialGalleryFiles);
  }, [initialInputMode, initialGalleryFiles, processGalleryFiles]);

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
    setReportDraft('');
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
    setReportDraft('');
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
    setReportDraft('');
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
    setReportDraft('');
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
    setReportDraft('');
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
  const displayText = guide.streamText || (
    initialInputMode === 'gallery'
      ? '저장된 PC 화면 사진이나 짧은 영상을 선택해주세요. 오류 문구, BIOS 화면, 검은 화면 단서를 사진 기준으로 먼저 분석할게요.'
      : STATIC_FIRST_GUIDE[context]
  );
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
  const canUseRawCvFallbackTarget = context === 'BIOS_BOOT' && initialInputMode !== 'gallery';
  const fallbackTextRegionTarget = canUseRawCvFallbackTarget && !selectedOcrTarget && !arHintMatchedTarget && !fallbackOcrTarget && !guide.isStreaming && guide.streamText
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
  const resolutionCheckQuestion = isActionMode
    ? '해당 내용을 조치하셨나요?'
    : activeOcrTarget
      ? '표시된 곳을 눌렀나요?'
      : '안내한 조치를 해보셨나요?';
  const resolutionTriedLabel = isActionMode
    ? '조치했어요'
    : activeOcrTarget
      ? '눌렀어요'
      : '해봤어요';
  const resolutionUnresolvedLabel = isActionMode
    ? '아직이에요'
    : activeOcrTarget
      ? '못 찾겠어요'
      : '아직이에요';
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
          title={cvPanelOpen ? '화면 인식 정보 닫기' : '화면 인식 정보 보기'}
          aria-label={cvPanelOpen ? '화면 인식 정보 닫기' : '화면 인식 정보 보기'}
          aria-pressed={cvPanelOpen}
          onClick={() => setCvPanelOpen(v => !v)}
        >
          {cvReady ? '🔬' : '⌛'}
        </button>
      </div>
      {guide.llmMode === 'mock' && (
        <div
          className={`nd-llm-status-strip ${guide.llmMode}`}
          role="alert"
          title={guide.llmError || 'Mock 안내 사용 중'}
        >
          <span className="nd-llm-status-dot" aria-hidden="true" />
          <span>Mock 안내 중</span>
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
            {hasFrozenFrame ? '화면 고정됨' : (biosCorners ? '화면 인식됨' : '화면을 맞춰주세요')}
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
        <button
          type="button"
          className={`nd-cv-panel-toggle${cvPanelOpen ? ' is-open' : ' is-collapsed'}${cvReady ? ' ready' : ''}`}
          onClick={() => setCvPanelOpen(v => !v)}
          aria-label={cvPanelOpen ? '화면 인식 정보 접기' : '화면 인식 정보 펼치기'}
          aria-pressed={cvPanelOpen}
        >
          {cvPanelOpen ? (
            <span aria-hidden="true">▶</span>
          ) : (
            <>
              <span className="nd-cv-panel-toggle-dot" aria-hidden="true" />
              <span>인식</span>
            </>
          )}
        </button>
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
            targeting={!!activeOcrTarget}
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
                  <span>{resolutionCheckQuestion}</span>
                  <button type="button" onClick={handleActionTried}>
                    {resolutionTriedLabel}
                  </button>
                  <button type="button" onClick={handleStillUnresolved}>
                    {resolutionUnresolvedLabel}
                  </button>
                </>
              ) : (
                <>
                  <span>어떻게 바뀌었는지 알려주세요 (선택)</span>
                  <textarea
                    className="nd-resolution-report-input"
                    value={reportDraft}
                    onChange={e => setReportDraft(e.target.value)}
                    placeholder="예: F2 눌렀는데 검은 화면이 떴어요"
                    maxLength={200}
                    rows={2}
                    disabled={resolutionCaptureDisabled}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const report = reportDraft.trim();
                      setReportDraft('');
                      void handleManualCapture(report || undefined);
                    }}
                    disabled={resolutionCaptureDisabled}
                  >
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
        <>
          <div className="nd-action-bar" role="toolbar" aria-label="진단 도구">
            {/* 주요: 다음 단계 (수동 캡처) — 중앙 */}
            <button
              type="button"
              className="nd-action-bar-btn nd-action-bar-primary nd-action-bar-capture"
              onPointerDown={initialInputMode === 'gallery' ? undefined : handleCapturePointerDown}
              onPointerUp={initialInputMode === 'gallery' ? undefined : e => void endCapturePointer(e, 'up')}
              onPointerCancel={initialInputMode === 'gallery' ? undefined : e => void endCapturePointer(e, 'cancel')}
              onClick={e => {
                if (initialInputMode === 'gallery') {
                  fileInputRef.current?.click();
                  return;
                }
                if (e.detail === 0 && clipCaptureState === 'idle' && !nextButtonDisabled) void handleManualCapture();
              }}
              disabled={nextButtonDisabled}
              aria-label={initialInputMode === 'gallery' ? '갤러리 사진 또는 동영상 선택' : guide.streamText ? '다음 화면 촬영 후 분석' : '현재 화면 촬영 후 분석'}
              title={initialInputMode === 'gallery' ? '사진/영상 선택' : '탭: 사진 · 길게: 깜빡임/소리'}
            >
              {initialInputMode !== 'gallery' && clipCaptureState === 'recording' && <span className="nd-capture-progress-ring" aria-hidden="true" />}
              {initialInputMode === 'gallery' && guide.captureState === 'idle' && clipCaptureState === 'idle'
                ? <span className="nd-action-bar-analyzing">사진 선택</span>
                : clipCaptureState === 'recording'
                ? <span className="nd-action-bar-analyzing">촬영 중</span>
                : clipCaptureState === 'analyzing' || guide.captureState !== 'idle'
                ? <span className="nd-action-bar-analyzing">분석 중…</span>
                : <Camera className="nd-action-bar-camera-icon" size={28} strokeWidth={2.4} aria-hidden="true" />
              }
            </button>
          </div>
          <div className="nd-capture-hint">탭: 사진 · 길게: 깜빡임/소리</div>
        </>
      )}

      {/* 갤러리 파일 피커 (hidden) — capture 없으면 모바일 갤러리 열림 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleGallerySelect}
        aria-hidden="true"
      />

      {/* ── ShootingGuide 오버레이 (카메라 위 반투명, 하단 정렬) ── */}
      {showShootingGuide && (
        <div className="nd-shooting-overlay">
          <ShootingGuide onDismiss={handleGuideStart} onBack={handleEnd} />
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
