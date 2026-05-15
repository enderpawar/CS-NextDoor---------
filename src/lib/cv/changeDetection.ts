/**
 * 모듈 2 — 라이브 프레임 변화 감지
 *
 * OpenCV.js cv.compareHist를 이용한 히스토그램 유사도 비교.
 * 4 메트릭 × 3 컬러 공간 × 3 윈도우 ablation은 notebooks/02-histogram-analysis.ipynb 참조.
 * BEST_PARAMS는 노트북 실험 결과 반영 예정 (현재: CORREL + GRAY + window=3).
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
 * 노트북 ablation 결과로 업데이트 예정.
 * 현재: CORREL + GRAY + 3프레임 연속 + threshold=0.92
 */
export const BEST_PARAMS = {
  metric:      'HISTCMP_CORREL' as HistMetric,
  colorSpace:  'GRAY' as ColorSpace,
  windowSize:  3,
  threshold:   0.92,
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
