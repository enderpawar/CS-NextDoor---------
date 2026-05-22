/**
 * 모듈 3 — 프레임 품질 사전 필터
 *
 * 런타임 분기:
 *   - 브라우저 (OpenCV.js WASM 로드 후) → `analyzeFrameWithOpenCv`
 *       cv.Laplacian + cv.meanStdDev로 sharpness, cv.meanStdDev로 brightness,
 *       cv.Sobel + cv.threshold + cv.findNonZero + cv.boundingRect로 edge/coverage,
 *       cv.calcHist + cv.normalize(NORM_L1)로 히스토그램.
 *   - Node / OpenCV.js 초기화 전 → `analyzeFrameWithJs` (수동 luma·Laplacian·히스토그램 누적)
 *
 * 두 경로 모두 같은 `CvFrameMetrics` 형상을 반환하며, 분류·점수 산식은 공유한다.
 *
 * References:
 *   - Pertuz et al. (2013) "Analysis of focus measure operators" — Laplacian variance
 *   - OpenCV cv::Laplacian / cv::meanStdDev / cv::calcHist 공식 문서
 */
import type { CvAnalysisOptions, CvFrameCandidate, CvFrameInput, CvFrameMetrics, FrameGuidance } from '../../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

/**
 * OpenCV.js WASM이 사용 가능한지 (테스트/SSR 환경에서는 false).
 * 호출 메서드를 직접 확인 — `cv` 글로벌만 존재하고 onRuntimeInitialized 전인 케이스와
 * 일부 OpenCV.js 빌드에서 선택적으로 빠지는 바인딩이 있는 케이스도 거름.
 */
function isOpenCvReady(): boolean {
  return typeof cv !== 'undefined'
    && typeof cv.Mat === 'function'
    && typeof cv.Laplacian === 'function'
    && typeof cv.meanStdDev === 'function'
    && typeof cv.calcHist === 'function'
    && typeof cv.findNonZero === 'function'
    && typeof cv.boundingRect === 'function';
}

const DEFAULT_OPTIONS: Required<CvAnalysisOptions> = {
  edgeThreshold: 26,
  // notebooks/03-frame-quality.ipynb Commons web-image ablation: Laplacian/1600 threshold.
  minSharpness: 0.05,
  minCoverageRatio: 0.04,
  maxCoverageRatio: 0.985,
  minBrightness: 0.15,
  maxBrightness: 0.85,
  histogramBins: 16,
  sceneChangeThreshold: 0.08,
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function validateFrame(frame: CvFrameInput): void {
  if (frame.width <= 0 || frame.height <= 0) {
    throw new Error(`Invalid frame dimensions: ${frame.width}x${frame.height}`);
  }
  const expected = frame.width * frame.height * 4;
  if (frame.data.length !== expected) {
    throw new Error(`Invalid RGBA data length for ${frame.id}: expected ${expected}, got ${frame.data.length}`);
  }
}

function createHistogram(bins: number): number[] {
  return Array.from({ length: bins }, () => 0);
}

function normalizeHistogram(histogram: number[], total: number): number[] {
  const divisor = total || 1;
  return histogram.map(count => count / divisor);
}

function addHistogramSample(histogram: number[], bins: number, luma: number): void {
  const bucket = Math.min(bins - 1, Math.floor(clamp01(luma) * bins));
  histogram[bucket] = (histogram[bucket] ?? 0) + 1;
}

function readLumaRow(
  frame: CvFrameInput,
  y: number,
  target: Float64Array,
  histogram: number[],
  histogramBins: number,
  accumulator: {
    brightnessSum: number;
    brightnessSquareSum: number;
  },
): void {
  let index = y * frame.width * 4;

  for (let x = 0; x < frame.width; x += 1) {
    const r = frame.data[index] ?? 0;
    const g = frame.data[index + 1] ?? 0;
    const b = frame.data[index + 2] ?? 0;
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    target[x] = luma;
    accumulator.brightnessSum += luma;
    accumulator.brightnessSquareSum += luma * luma;
    addHistogramSample(histogram, histogramBins, luma);
    index += 4;
  }
}

function createBrightnessAccumulator(): {
  brightnessSum: number;
  brightnessSquareSum: number;
} {
  return { brightnessSum: 0, brightnessSquareSum: 0 };
}

export function compareHistograms(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let intersection = 0;
  for (let i = 0; i < a.length; i += 1) {
    intersection += Math.min(a[i] ?? 0, b[i] ?? 0);
  }
  return clamp01(intersection);
}

function classifyGuidance(metrics: {
  brightnessMean: number;
  sharpnessScore: number;
  coverageRatio: number;
}, options: Required<CvAnalysisOptions>): { guidance: FrameGuidance; guidanceText: string; isUsable: boolean } {
  if (metrics.brightnessMean < options.minBrightness) {
    return { guidance: 'too_dark', guidanceText: '조명이 너무 어두워요', isUsable: false };
  }
  if (metrics.brightnessMean > options.maxBrightness) {
    return { guidance: 'too_bright', guidanceText: '빛 반사가 너무 강해요', isUsable: false };
  }
  if (metrics.sharpnessScore < options.minSharpness) {
    return { guidance: 'stabilize', guidanceText: '카메라를 고정해 주세요', isUsable: false };
  }
  if (metrics.coverageRatio <= 0) {
    return { guidance: 'no_target', guidanceText: 'PC 내부나 오류 화면을 향해 주세요', isUsable: false };
  }
  if (metrics.coverageRatio < options.minCoverageRatio) {
    return { guidance: 'too_far', guidanceText: '대상에 조금 더 가까이 가 주세요', isUsable: false };
  }
  return { guidance: 'ready', guidanceText: '좋아요. 진단에 사용할 수 있어요', isUsable: true };
}

export function analyzeFrame(
  frame: CvFrameInput,
  previousHistogram?: number[],
  options: CvAnalysisOptions = {},
): CvFrameMetrics {
  validateFrame(frame);
  const resolved = { ...DEFAULT_OPTIONS, ...options };

  // OpenCV.js가 로드돼 있으면 cv.Laplacian / cv.meanStdDev / cv.calcHist 경로로.
  // 미로딩(테스트 or 초기화 전)인 경우 JS 폴백 — 결과 형상 동일.
  return isOpenCvReady()
    ? analyzeFrameWithOpenCv(frame, previousHistogram, resolved)
    : analyzeFrameWithJs(frame, previousHistogram, resolved);
}

/**
 * OpenCV.js 기반 핵심 메트릭 계산.
 * 모든 Mat은 try/finally에서 .delete() — JS GC는 WASM 힙 미회수.
 */
function analyzeFrameWithOpenCv(
  frame: CvFrameInput,
  previousHistogram: number[] | undefined,
  resolved: Required<CvAnalysisOptions>,
): CvFrameMetrics {
  // Uint8ClampedArray → ImageData → cv.Mat. ImageData 생성자는 SharedArrayBuffer 호환 이슈가 있어
  // 항상 새 Uint8ClampedArray로 복사한 뒤 넘긴다.
  const imageData = new ImageData(
    new Uint8ClampedArray(frame.data),
    frame.width,
    frame.height,
  );

  const src       = cv.matFromImageData(imageData);
  const gray      = new cv.Mat();
  const lap       = new cv.Mat();
  const lapMean   = new cv.Mat();
  const lapStd    = new cv.Mat();
  const grayMean  = new cv.Mat();
  const grayStd   = new cv.Mat();
  const sobelX    = new cv.Mat();
  const sobelY    = new cv.Mat();
  const sobelXAbs = new cv.Mat();
  const sobelYAbs = new cv.Mat();
  const magnitude = new cv.Mat();
  const edgeMask  = new cv.Mat();
  const hist      = new cv.Mat();
  const histMask  = new cv.Mat();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const histVec   = new cv.MatVector();
  const nzPoints  = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // ── Laplacian variance — 헤드라인 OpenCV 호출 ①: 블러 검출 ───────────────────
    // 3×3 Laplacian (default ksize=1 → kernel [[0,1,0],[1,-4,1],[0,1,0]])은 JS 폴백의 4-이웃
    // 스텐실과 수치적으로 동일. CV_64F로 출력해야 음수 응답이 잘리지 않는다.
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, lapMean, lapStd);
    const lapStdVal = lapStd.doubleAt(0, 0);
    const laplacianVariance = lapStdVal * lapStdVal;

    // ── Brightness 통계 — 헤드라인 OpenCV 호출 ②: 노출/대비 ──────────────────────
    cv.meanStdDev(gray, grayMean, grayStd);
    const brightnessMean   = grayMean.doubleAt(0, 0) / 255;
    const brightnessStdDev = grayStd.doubleAt(0, 0) / 255;

    // ── Edge density — Sobel magnitude → threshold → countNonZero ────────────────
    cv.Sobel(gray, sobelX, cv.CV_32F, 1, 0);
    cv.Sobel(gray, sobelY, cv.CV_32F, 0, 1);
    cv.convertScaleAbs(sobelX, sobelXAbs);
    cv.convertScaleAbs(sobelY, sobelYAbs);
    cv.addWeighted(sobelXAbs, 1.0, sobelYAbs, 1.0, 0, magnitude);
    cv.threshold(magnitude, edgeMask, resolved.edgeThreshold, 255, cv.THRESH_BINARY);
    const edgeCount = cv.countNonZero(edgeMask);
    const innerArea = Math.max(1, (frame.width - 2) * (frame.height - 2));
    const edgeDensity = edgeCount / innerArea;

    // ── Coverage — 비-제로 픽셀의 bounding box로 ROI 영역 비율 추정 ───────────────
    let coverageRatio = 0;
    if (edgeCount > 0) {
      cv.findNonZero(edgeMask, nzPoints);
      const rect = cv.boundingRect(nzPoints);
      coverageRatio = (rect.width * rect.height) / (frame.width * frame.height);
    }

    // ── Histogram — 헤드라인 OpenCV 호출 ③: 노출 분포 + 장면 변화 ────────────────
    // NORM_L1 + alpha=1 → 히스토그램 합 = 1. JS 폴백의 count/total과 동일한 정규화.
    histVec.push_back(gray);
    cv.calcHist(histVec, [0], histMask, hist, [resolved.histogramBins], [0, 256]);
    cv.normalize(hist, hist, 1, 0, cv.NORM_L1);
    const normalizedHistogram: number[] = [];
    for (let i = 0; i < resolved.histogramBins; i += 1) {
      normalizedHistogram.push(hist.floatAt(i, 0));
    }

    const sharpnessScore = clamp01(laplacianVariance / 1600);
    const histogramSimilarity = previousHistogram
      ? compareHistograms(normalizedHistogram, previousHistogram)
      : undefined;
    const sceneChangeScore = histogramSimilarity === undefined
      ? undefined
      : 1 - histogramSimilarity;

    const exposureScore = clamp01(1 - Math.abs(brightnessMean - 0.5) / 0.5);
    const contrastScore = clamp01(brightnessStdDev / 0.22);
    const brightnessScore = 0.62 * exposureScore + 0.38 * contrastScore;
    const edgeScore = clamp01(edgeDensity / 0.18);
    const coverageScore = clamp01(coverageRatio / 0.45);
    const changeScore = sceneChangeScore === undefined
      ? 0.65
      : clamp01(sceneChangeScore / Math.max(0.001, resolved.sceneChangeThreshold));
    const qualityScore = Math.round(100 * (
      0.32 * sharpnessScore +
      0.24 * brightnessScore +
      0.24 * coverageScore +
      0.12 * edgeScore +
      0.08 * changeScore
    ));

    const classification = classifyGuidance(
      { brightnessMean, sharpnessScore, coverageRatio },
      resolved,
    );

    return {
      id: frame.id,
      width: frame.width,
      height: frame.height,
      brightnessMean,
      brightnessStdDev,
      laplacianVariance,
      sharpnessScore,
      edgeDensity,
      coverageRatio,
      histogram: normalizedHistogram,
      histogramSimilarity,
      sceneChangeScore,
      qualityScore,
      ...classification,
    };
  } finally {
    [
      src, gray,
      lap, lapMean, lapStd,
      grayMean, grayStd,
      sobelX, sobelY, sobelXAbs, sobelYAbs, magnitude, edgeMask,
      hist, histMask, nzPoints,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ].forEach((m: any) => m.delete());
    histVec.delete();
  }
}

/**
 * OpenCV.js 미로딩 환경(테스트, SSR, WASM 초기화 전)용 폴백.
 * 단일 루프로 luma·Laplacian·히스토그램·Sobel-like edge·coverage를 함께 누적.
 */
function analyzeFrameWithJs(
  frame: CvFrameInput,
  previousHistogram: number[] | undefined,
  resolved: Required<CvAnalysisOptions>,
): CvFrameMetrics {
  const histogram = createHistogram(resolved.histogramBins);
  const brightnessAccumulator = createBrightnessAccumulator();
  let laplacianSum = 0;
  let laplacianSquareSum = 0;
  let laplacianCount = 0;
  let edgeCount = 0;
  let minX = frame.width;
  let minY = frame.height;
  let maxX = -1;
  let maxY = -1;
  const pixelCount = frame.width * frame.height;
  const lumaRows = [
    new Float64Array(frame.width),
    new Float64Array(frame.width),
    new Float64Array(frame.width),
  ];

  for (let y = 0; y < frame.height; y += 1) {
    const row = lumaRows[y % lumaRows.length]!;
    readLumaRow(frame, y, row, histogram, resolved.histogramBins, brightnessAccumulator);

    if (y < 2) continue;

    const centerY = y - 1;
    const topRow = lumaRows[(y - 2) % lumaRows.length]!;
    const centerRow = lumaRows[(y - 1) % lumaRows.length]!;
    const bottomRow = row;

    for (let x = 1; x < frame.width - 1; x += 1) {
      const center = centerRow[x]!;
      const left = centerRow[x - 1]!;
      const right = centerRow[x + 1]!;
      const top = topRow[x]!;
      const bottom = bottomRow[x]!;
      const laplacian = (4 * center - left - right - top - bottom) * 255;
      laplacianSum += laplacian;
      laplacianSquareSum += laplacian * laplacian;
      laplacianCount += 1;

      const dx = right - left;
      const dy = bottom - top;
      const gradient = Math.sqrt(dx * dx + dy * dy) * 255;
      if (gradient >= resolved.edgeThreshold) {
        edgeCount += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, centerY);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, centerY);
      }
    }
  }

  const brightnessMean = pixelCount === 0 ? 0 : brightnessAccumulator.brightnessSum / pixelCount;
  const brightnessVariance = pixelCount === 0
    ? 0
    : Math.max(0, brightnessAccumulator.brightnessSquareSum / pixelCount - brightnessMean ** 2);
  const brightnessStdDev = Math.sqrt(brightnessVariance);
  const laplacianMean = laplacianCount === 0 ? 0 : laplacianSum / laplacianCount;
  const laplacianVariance = laplacianCount === 0
    ? 0
    : Math.max(0, laplacianSquareSum / laplacianCount - laplacianMean ** 2);
  const sharpnessScore = clamp01(laplacianVariance / 1600);
  const innerArea = Math.max(1, (frame.width - 2) * (frame.height - 2));
  const edgeDensity = edgeCount / innerArea;
  const coverageRatio = maxX >= minX && maxY >= minY
    ? ((maxX - minX + 1) * (maxY - minY + 1)) / (frame.width * frame.height)
    : 0;
  const normalizedHistogram = normalizeHistogram(histogram, pixelCount);
  const histogramSimilarity = previousHistogram ? compareHistograms(normalizedHistogram, previousHistogram) : undefined;
  const sceneChangeScore = histogramSimilarity === undefined ? undefined : 1 - histogramSimilarity;

  const exposureScore = clamp01(1 - Math.abs(brightnessMean - 0.5) / 0.5);
  const contrastScore = clamp01(brightnessStdDev / 0.22);
  const brightnessScore = 0.62 * exposureScore + 0.38 * contrastScore;
  const edgeScore = clamp01(edgeDensity / 0.18);
  const coverageScore = clamp01(coverageRatio / 0.45);
  const changeScore = sceneChangeScore === undefined
    ? 0.65
    : clamp01(sceneChangeScore / Math.max(0.001, resolved.sceneChangeThreshold));
  const qualityScore = Math.round(100 * (
    0.32 * sharpnessScore +
    0.24 * brightnessScore +
    0.24 * coverageScore +
    0.12 * edgeScore +
    0.08 * changeScore
  ));

  const classification = classifyGuidance({ brightnessMean, sharpnessScore, coverageRatio }, resolved);

  return {
    id: frame.id,
    width: frame.width,
    height: frame.height,
    brightnessMean,
    brightnessStdDev,
    laplacianVariance,
    sharpnessScore,
    edgeDensity,
    coverageRatio,
    histogram: normalizedHistogram,
    histogramSimilarity,
    sceneChangeScore,
    qualityScore,
    ...classification,
  };
}

export function selectTopFrames(
  frames: CvFrameInput[],
  limit: number,
  options: CvAnalysisOptions = {},
): CvFrameCandidate[] {
  const candidates: CvFrameCandidate[] = [];
  let previousHistogram: number[] | undefined;

  for (const frame of frames) {
    const metrics = analyzeFrame(frame, previousHistogram, options);
    previousHistogram = metrics.histogram;
    if (metrics.isUsable) {
      candidates.push({ frame, metrics });
    }
  }

  return candidates
    .sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore)
    .slice(0, Math.max(0, limit));
}

export function summarizeFrameSet(frames: CvFrameInput[], options: CvAnalysisOptions = {}) {
  const metrics: CvFrameMetrics[] = [];
  let previousHistogram: number[] | undefined;

  for (const frame of frames) {
    const metric = analyzeFrame(frame, previousHistogram, options);
    metrics.push(metric);
    previousHistogram = metric.histogram;
  }

  const usable = metrics.filter(metric => metric.isUsable);
  const avgQuality = metrics.length === 0
    ? 0
    : Math.round(metrics.reduce((sum, metric) => sum + metric.qualityScore, 0) / metrics.length);

  return {
    total: metrics.length,
    usable: usable.length,
    rejected: metrics.length - usable.length,
    avgQuality,
    metrics,
  };
}
