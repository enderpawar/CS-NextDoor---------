import type { CvAnalysisOptions, CvFrameCandidate, CvFrameInput, CvFrameMetrics, FrameGuidance } from '../../types';

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

function lumaAt(frame: CvFrameInput, x: number, y: number): number {
  const index = (y * frame.width + x) * 4;
  const r = frame.data[index] ?? 0;
  const g = frame.data[index + 1] ?? 0;
  const b = frame.data[index + 2] ?? 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
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
  const histogram = createHistogram(resolved.histogramBins);
  let brightnessSum = 0;
  let brightnessSquareSum = 0;
  let laplacianSum = 0;
  let laplacianSquareSum = 0;
  let laplacianCount = 0;
  let edgeCount = 0;
  let minX = frame.width;
  let minY = frame.height;
  let maxX = -1;
  let maxY = -1;
  const pixelCount = frame.width * frame.height;

  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const luma = lumaAt(frame, x, y);
      brightnessSum += luma;
      brightnessSquareSum += luma * luma;
      addHistogramSample(histogram, resolved.histogramBins, luma);
    }
  }

  for (let y = 1; y < frame.height - 1; y += 1) {
    for (let x = 1; x < frame.width - 1; x += 1) {
      const center = lumaAt(frame, x, y);
      const left = lumaAt(frame, x - 1, y);
      const right = lumaAt(frame, x + 1, y);
      const top = lumaAt(frame, x, y - 1);
      const bottom = lumaAt(frame, x, y + 1);
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
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const brightnessMean = pixelCount === 0 ? 0 : brightnessSum / pixelCount;
  const brightnessVariance = pixelCount === 0
    ? 0
    : Math.max(0, brightnessSquareSum / pixelCount - brightnessMean ** 2);
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
