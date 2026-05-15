/**
 * 모듈 1 — BIOS 화면 End-to-End 파이프라인
 *
 * Hough Line → Homography(정면화) → CLAHE(대비 강화) →
 * Adaptive Threshold → Connected Components → Tesseract.js OCR
 *
 * 파라미터는 notebooks/01-bios-pipeline.ipynb ablation 결과 반영 예정.
 * 현재: CLAHE clipLimit=2.0, grid=8, AdaptiveGaussian blockSize=11 C=2
 *
 * References:
 *   - Hough (1962) US Patent 3,069,654
 *   - Pizer et al. (1987) CVGIP 39(3) — CLAHE
 *   - Bradley & Roth (2007) JGT 12(2) — Adaptive Threshold
 *   - Smith (2007) ICDAR — Tesseract OCR
 */

import Tesseract from 'tesseract.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

export interface BiosPipelineResult {
  rectified:   boolean;    // Homography 정면화 성공 여부
  ocrText:     string;     // Tesseract 전체 텍스트
  menuItems:   string[];   // 정리된 메뉴 항목 목록
  confidence:  number;     // OCR 신뢰도 0.0~1.0
  processingMs: number;    // 처리 시간 (ms)
}

// ablation 결과 반영 예정 — 노트북 실험 후 업데이트
const CLAHE_CLIP  = 2.0;
const CLAHE_GRID  = 8;
const ADAPT_BLOCK = 11;   // Adaptive Threshold block size (홀수)
const ADAPT_C     = 2;    // Adaptive Threshold C 상수
const MIN_CC_AREA = 50;   // Connected Component 최소 픽셀 수
const HOUGH_VOTE  = 80;   // HoughLinesP accumulator threshold
const HOUGH_MIN   = 50;   // 최소 선 길이 (px)
const HOUGH_GAP   = 10;   // 최대 선 간격 (px)

/**
 * RGBA ImageData → BIOS 화면 분석
 * 모든 OpenCV Mat은 finally에서 해제 — JS GC는 WASM 힙 미회수
 */
export async function runBiosPipeline(rgba: ImageData): Promise<BiosPipelineResult> {
  const t0 = performance.now();
  let rectified = false;

  const src      = cv.matFromImageData(rgba);
  const gray     = new cv.Mat();
  const edges    = new cv.Mat();
  const lines    = new cv.Mat();
  const enhanced = new cv.Mat();
  const binary   = new cv.Mat();
  const labels   = new cv.Mat();
  const stats    = new cv.Mat();
  const centroids = new cv.Mat();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clahe    = new cv.CLAHE(CLAHE_CLIP, new cv.Size(CLAHE_GRID, CLAHE_GRID));
  let   warped: any = null;

  try {
    // ── Step 1: 그레이스케일 ────────────────────────────────────────────────
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // ── Step 2: Canny + HoughLinesP → 화면 경계 4 모서리 추출 ───────────────
    cv.Canny(gray, edges, 50, 150);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, HOUGH_VOTE, HOUGH_MIN, HOUGH_GAP);
    const corners = extractQuadCorners(lines, rgba.width, rgba.height);

    // ── Step 3: Homography + warpPerspective — 정면화 ─────────────────────
    if (corners) {
      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.src.flat());
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.dst.flat());
      const H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 5.0);
      if (H && !H.empty()) {
        warped = new cv.Mat();
        cv.warpPerspective(gray, warped, H, new cv.Size(rgba.width, rgba.height));
        rectified = true;
      }
      srcPts.delete();
      dstPts.delete();
      H?.delete();
    }

    const input: any = warped ?? gray;

    // ── Step 4: CLAHE — 대비 제한 적응형 히스토그램 균등화 ──────────────────
    clahe.apply(input, enhanced);

    // ── Step 5: Adaptive Gaussian Threshold — 불균일 조명 대응 ──────────────
    cv.adaptiveThreshold(
      enhanced, binary, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      ADAPT_BLOCK, ADAPT_C,
    );

    // ── Step 6: Connected Components — 텍스트 ROI 분리 ──────────────────────
    cv.connectedComponentsWithStats(binary, labels, stats, centroids);
    const numLabels: number = labels.rows > 0 ? (stats.rows - 1) : 0;  // label 0 = background
    const textRoiCount = countTextRegions(stats, numLabels);
    void textRoiCount; // ablation 분석용 (현재 OCR 입력 필터링 미구현)

    // ── Step 7: Tesseract.js OCR ─────────────────────────────────────────────
    // enhanced Mat → off-screen canvas → Tesseract
    const ocrCanvas = document.createElement('canvas');
    ocrCanvas.width  = rgba.width;
    ocrCanvas.height = rgba.height;
    cv.imshow(ocrCanvas, enhanced);

    const { data } = await Tesseract.recognize(ocrCanvas, 'eng', {
      // @ts-ignore — tesseract.js는 문자열 옵션 사용
      tessedit_pageseg_mode: '6',  // PSM 6: assume uniform block of text
    });

    const ocrText  = data.text.trim();
    const confidence = (data.confidence ?? 0) / 100;
    const menuItems = extractMenuItems(ocrText);

    return {
      rectified,
      ocrText,
      menuItems,
      confidence,
      processingMs: performance.now() - t0,
    };
  } finally {
    [src, gray, edges, lines, enhanced, binary, labels, stats, centroids].forEach(m => m.delete());
    warped?.delete();
    clahe.delete();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** HoughLinesP 결과 Mat에서 화면 4 모서리 좌표 추출 */
function extractQuadCorners(
  lines: any,
  width: number,
  height: number,
): { src: number[][]; dst: number[][] } | null {
  const hLines: number[][] = [];
  const vLines: number[][] = [];

  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4 + 0];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const angleDeg = Math.abs(Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI));

    if (angleDeg < 20)       hLines.push([x1, y1, x2, y2]);
    else if (angleDeg > 70)  vLines.push([x1, y1, x2, y2]);
  }

  if (hLines.length < 2 || vLines.length < 2) return null;

  hLines.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));     // y 오름차순
  vLines.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));     // x 오름차순

  const top    = hLines[0]!;
  const bottom = hLines[hLines.length - 1]!;
  const left   = vLines[0]!;
  const right  = vLines[vLines.length - 1]!;

  const tl = [left[0]!, top[1]!];
  const tr = [right[0]!, top[1]!];
  const br = [right[0]!, bottom[1]!];
  const bl = [left[0]!, bottom[1]!];

  const quadW = Math.abs(tr[0]! - tl[0]!);
  const quadH = Math.abs(bl[1]! - tl[1]!);

  // 너무 작은 사각형은 노이즈로 판단
  if (quadW < width * 0.15 || quadH < height * 0.15) return null;

  return {
    src: [tl, tr, br, bl],
    dst: [
      [0, 0],
      [width - 1, 0],
      [width - 1, height - 1],
      [0, height - 1],
    ],
  };
}

/** Connected Components에서 면적 MIN_CC_AREA 이상인 텍스트 ROI 수 반환 */
function countTextRegions(stats: any, numLabels: number): number {
  let count = 0;
  for (let i = 1; i <= numLabels; i++) {
    const area: number = stats.intAt(i, cv.CC_STAT_AREA);
    if (area >= MIN_CC_AREA) count++;
  }
  return count;
}

/** OCR 텍스트 줄 분리 → 2~60자 항목만 추출 */
function extractMenuItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 2 && line.length <= 60);
}
