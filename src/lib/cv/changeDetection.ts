/**
 * 모듈 2 — 라이브 프레임 변화 감지
 *
 * OpenCV.js cv.compareHist를 이용한 히스토그램 유사도 비교.
 * 4 메트릭 × 3 컬러 공간 × 3 윈도우 ablation은 notebooks/02-histogram-analysis.ipynb 참조.
 * BEST_PARAMS는 notebooks/02-histogram-analysis.ipynb synthetic ablation 결과 반영.
 *
 * References:
 *   - Swain & Ballard (1991) "Color Indexing"
 *   - OpenCV cv::compareHist docs
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

export type HistMetric =
  | 'HISTCMP_CORREL'         // 1.0 = 동일, 낮을수록 변화  ← 기본값
  | 'HISTCMP_CHISQR'         // 0 = 동일, 높을수록 변화
  | 'HISTCMP_BHATTACHARYYA'  // 0 = 동일, 높을수록 변화
  | 'HISTCMP_INTERSECT';     // 클수록 유사 (정규화 후)

export type ColorSpace = 'GRAY' | 'HSV' | 'RGB';

/**
 * 2026-05-22 실측 ablation — `notebooks/run_module2_real_ablation.py`.
 * 입력: `data/live-frames/real/Test_video.mp4` (54s, 1080p, 30fps phone capture, 6 labeled BIOS transitions).
 *
 * Best combo: CORREL × RGB × window=3, mean F1=0.34, ROC AUC=0.70.
 * - synthetic ablation의 threshold=0.9999는 합성 영상의 픽셀 단위 동일성에 의존 → 실측 카메라 노이즈·AE·손떨림에서는 비현실적.
 * - 실측 기반 보정: 0.9999 → 0.9995 (similarity 도메인). 강도 도메인으로는 0.00045.
 * - colorSpace: GRAY(F1=0.328) → RGB(F1=0.340). 차이는 작지만 RGB가 색조 변화에 추가 정보 활용.
 * - windowSize: 5 → 3. 더 빠른 반응. cooldown(2s) + 모듈 3 quality gate + isSendingRef가 FP 추가 차단.
 *
 * 자세한 비교: docs/ablation-results/histogram-real-heatmap.png, histogram-real-roc.png.
 */
export const BEST_PARAMS = {
  metric:      'HISTCMP_CORREL' as HistMetric,
  colorSpace:  'RGB' as ColorSpace,
  windowSize:  3,
  threshold:   0.9995,
} as const;

function metricToOpenCV(m: HistMetric): number {
  switch (m) {
    case 'HISTCMP_CORREL':        return cv.HISTCMP_CORREL;
    case 'HISTCMP_CHISQR':        return cv.HISTCMP_CHISQR;
    case 'HISTCMP_BHATTACHARYYA': return cv.HISTCMP_BHATTACHARYYA;
    case 'HISTCMP_INTERSECT':     return cv.HISTCMP_INTERSECT;
  }
}

/**
 * RGBA ImageData → 정규화된 그레이스케일 256-bin 히스토그램 Mat
 *
 * 반환된 Mat은 **호출자가 .delete() 책임**.
 * try/finally 패턴 필수 — JS GC는 WASM 힙 미회수.
 */
export function computeGrayHistogram(rgba: ImageData): any {
  const src     = cv.matFromImageData(rgba);
  const gray    = new cv.Mat();
  const hist    = new cv.Mat();
  const mask    = new cv.Mat();
  const matVec  = new cv.MatVector();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    matVec.push_back(gray);
    cv.calcHist(matVec, [0], mask, hist, [256], [0, 256]);
    cv.normalize(hist, hist, 0, 1, cv.NORM_MINMAX);
    return hist;          // caller owns this Mat
  } finally {
    src.delete();
    gray.delete();
    mask.delete();
    matVec.delete();
    // hist는 반환하므로 여기서 delete하지 않음
  }
}

/**
 * RGBA ImageData → 정규화된 HSV H-채널 180-bin 히스토그램 Mat
 * 색조(Hue) 기반: 조명 밝기 변화에 강건
 */
export function computeHsvHistogram(rgba: ImageData): any {
  const src     = cv.matFromImageData(rgba);
  const bgr     = new cv.Mat();
  const hsv     = new cv.Mat();
  const hist    = new cv.Mat();
  const mask    = new cv.Mat();
  const matVec  = new cv.MatVector();
  try {
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    matVec.push_back(hsv);
    cv.calcHist(matVec, [0], mask, hist, [180], [0, 180]);
    cv.normalize(hist, hist, 0, 1, cv.NORM_MINMAX);
    return hist;
  } finally {
    src.delete();
    bgr.delete();
    hsv.delete();
    mask.delete();
    matVec.delete();
  }
}

/**
 * RGBA ImageData → 정규화된 RGB 3채널 결합 히스토그램 Mat
 */
export function computeRgbHistogram(rgba: ImageData): any {
  const src     = cv.matFromImageData(rgba);
  const rgb     = new cv.Mat();
  const hist    = new cv.Mat();
  const channelHists: any[] = [];
  const mask    = new cv.Mat();
  const matVec  = new cv.MatVector();
  const histVec = new cv.MatVector();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    matVec.push_back(rgb);
    for (let channel = 0; channel < 3; channel += 1) {
      const channelHist = new cv.Mat();
      cv.calcHist(matVec, [channel], mask, channelHist, [64], [0, 256]);
      channelHists.push(channelHist);
      histVec.push_back(channelHist);
    }
    cv.vconcat(histVec, hist);
    cv.normalize(hist, hist, 0, 1, cv.NORM_MINMAX);
    return hist;
  } finally {
    src.delete();
    rgb.delete();
    mask.delete();
    matVec.delete();
    histVec.delete();
    channelHists.forEach(channelHist => channelHist.delete());
  }
}

export function computeHistogram(
  rgba: ImageData,
  colorSpace: ColorSpace = BEST_PARAMS.colorSpace,
): any {
  switch (colorSpace) {
    case 'GRAY':
      return computeGrayHistogram(rgba);
    case 'HSV':
      return computeHsvHistogram(rgba);
    case 'RGB':
      return computeRgbHistogram(rgba);
  }
}

/**
 * 두 히스토그램 Mat의 유사도 점수 반환.
 * h1, h2는 호출 후에도 살아있음 — delete는 호출자 책임.
 */
export function compareHist(
  h1: any,
  h2: any,
  metric: HistMetric = BEST_PARAMS.metric,
): number {
  return cv.compareHist(h1, h2, metricToOpenCV(metric));
}

/**
 * 유사도 점수 → 화면 변화 여부 판단.
 * CORREL/INTERSECT: threshold 미만이면 변화.
 * CHISQR/BHATTACHARYYA: (1-threshold) 초과이면 변화.
 */
export function isSceneChanged(
  score: number,
  metric: HistMetric = BEST_PARAMS.metric,
  threshold: number  = BEST_PARAMS.threshold,
): boolean {
  switch (metric) {
    case 'HISTCMP_CORREL':
    case 'HISTCMP_INTERSECT':
      return score < threshold;
    case 'HISTCMP_CHISQR':
    case 'HISTCMP_BHATTACHARYYA':
      return score > (1 - threshold);
  }
}
