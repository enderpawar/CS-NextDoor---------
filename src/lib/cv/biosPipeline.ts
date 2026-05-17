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
import type { BiosType } from '../../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

/**
 * OCR 텍스트 또는 Gemini 응답 텍스트에서 BIOS 제조사 감지.
 * 우선순위: Phoenix > Award > AMI (겹침 방지 — AMI는 다수 OEM 라이선시)
 */
const VENDOR_PATTERNS: { pattern: RegExp; vendor: BiosType }[] = [
  { pattern: /\b(Phoenix|PhoenixBIOS|Phoenix-Award)\b/i, vendor: 'Phoenix' },
  { pattern: /\b(Award|AWARDBIOS|Award Modular|Award-Phoenix)\b/i, vendor: 'Award' },
  { pattern: /\b(AMI|AMIBIOS|AMIBIOS64|American Megatrends|Aptio Setup|UEFI BIOS Utility)\b/i, vendor: 'AMI' },
  // 흔한 AMI 라이선시 브랜드 — BIOS 화면에 제조사명 표기 시
  { pattern: /\b(ASUS|Gigabyte|MSI|AsRock|ASRock)\b/i, vendor: 'AMI' },
];

export function detectBiosVendor(text: string): BiosType | null {
  for (const { pattern, vendor } of VENDOR_PATTERNS) {
    if (pattern.test(text)) return vendor;
  }
  return null;
}

export interface BiosPipelineResult {
  rectified:   boolean;    // Homography 정면화 성공 여부
  ocrText:     string;     // Tesseract 전체 텍스트
  menuItems:   string[];   // 정리된 메뉴 항목 목록
  detectedVendor: BiosType | null; // OCR 텍스트에서 추론한 BIOS 제조사
  confidence:  number;     // OCR 신뢰도 0.0~1.0
  processingMs: number;    // 처리 시간 (ms)
}

export interface BiosGuidePreprocessResult {
  canvas: HTMLCanvasElement;
  rectified: boolean;
  textRegionCount: number;
  /** Connected Components 텍스트 후보 영역 (원본 프레임 픽셀 공간) */
  textRegions: BiosTextRegion[];
  processingMs: number;
  /** Hough 검출 4 모서리 좌표 (원본 프레임 픽셀 공간). [tl, tr, br, bl] 순서 */
  corners: number[][] | null;
}

export interface BiosTextRegion {
  id: number;
  area: number;
  /** 원본 프레임 픽셀 공간의 4점 폴리곤. [tl, tr, br, bl] 순서 */
  points: number[][];
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
 * 라이브 가이드용 경량 모듈 1 전처리.
 * OCR은 Gemini Vision이 담당하므로, 브라우저에서는 정면화 + CLAHE + 텍스트 ROI 계수만 수행한다.
 */
export function preprocessBiosFrameForGuide(rgba: ImageData): BiosGuidePreprocessResult {
  const t0 = performance.now();
  let rectified = false;
  let textRegionCount = 0;

  const src       = cv.matFromImageData(rgba);
  const gray      = new cv.Mat();
  const edges     = new cv.Mat();
  const lines     = new cv.Mat();
  const enhanced  = new cv.Mat();
  const binary    = new cv.Mat();
  const labels    = new cv.Mat();
  const stats     = new cv.Mat();
  const centroids = new cv.Mat();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clahe     = new cv.CLAHE(CLAHE_CLIP, new cv.Size(CLAHE_GRID, CLAHE_GRID));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warped: any = null;
  let homographyInv: any = null;

  let detectedCorners: number[][] | null = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 50, 150);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, HOUGH_VOTE, HOUGH_MIN, HOUGH_GAP);

    const corners = extractQuadCorners(lines, rgba.width, rgba.height);
    if (corners) {
      detectedCorners = corners.src;   // AR 오버레이용 — 원본 프레임 좌표
      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.src.flat());
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.dst.flat());
      const H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 5.0);
      try {
        if (H && !H.empty()) {
          warped = new cv.Mat();
          cv.warpPerspective(gray, warped, H, new cv.Size(rgba.width, rgba.height));
          homographyInv = new cv.Mat();
          cv.invert(H, homographyInv);
          rectified = true;
        }
      } finally {
        srcPts.delete();
        dstPts.delete();
        H?.delete();
      }
    }

    const input = warped ?? gray;
    clahe.apply(input, enhanced);
    cv.adaptiveThreshold(
      enhanced, binary, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      ADAPT_BLOCK, ADAPT_C,
    );

    cv.connectedComponentsWithStats(binary, labels, stats, centroids);
    const numLabels: number = labels.rows > 0 ? (stats.rows - 1) : 0;
    textRegionCount = countTextRegions(stats, numLabels);
    const textRegions = collectTextRegions(
      stats,
      numLabels,
      rgba.width,
      rgba.height,
      homographyInv,
    );

    const canvas = document.createElement('canvas');
    canvas.width = rgba.width;
    canvas.height = rgba.height;
    cv.imshow(canvas, enhanced);

    return {
      canvas,
      rectified,
      textRegionCount,
      textRegions,
      processingMs: performance.now() - t0,
      corners: detectedCorners,
    };
  } finally {
    [src, gray, edges, lines, enhanced, binary, labels, stats, centroids].forEach(m => m.delete());
    warped?.delete();
    homographyInv?.delete();
    clahe.delete();
  }
}

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let H: any = null;
      try {
        H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 5.0);
        if (H && !H.empty()) {
          warped = new cv.Mat();
          cv.warpPerspective(gray, warped, H, new cv.Size(rgba.width, rgba.height));
          rectified = true;
        }
      } finally {
        srcPts.delete();
        dstPts.delete();
        H?.delete();
      }
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
    const detectedVendor = detectBiosVendor(ocrText);

    return {
      rectified,
      ocrText,
      menuItems,
      detectedVendor,
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

/**
 * HoughLinesP 결과 Mat에서 화면 4 모서리 좌표 추출.
 *
 * 알고리즘:
 *   1) 각 라인의 기울기로 horizontal / vertical 분류
 *   2) horizontal은 평균 y, vertical은 평균 x 기준 정렬
 *   3) 가장 위/아래/왼/오른쪽 라인 한 개씩 선택
 *   4) 4 쌍의 라인 교차점을 직선 방정식으로 계산 → tl/tr/br/bl
 *
 * 사선으로 비춰진 BIOS 화면(trapezoid)에서도 올바른 모서리를 얻기 위해
 * 좌표 합성(axis-aligned)이 아닌 교차점 계산을 사용한다.
 */
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

  // 라인의 평균 y / 평균 x 기준 정렬 (사선 라인에서도 robust)
  hLines.sort((a, b) => avgY(a) - avgY(b));
  vLines.sort((a, b) => avgX(a) - avgX(b));

  const topLine    = hLines[0]!;
  const bottomLine = hLines[hLines.length - 1]!;
  const leftLine   = vLines[0]!;
  const rightLine  = vLines[vLines.length - 1]!;

  // 교차점 = 화면 모서리
  const tl = lineIntersect(topLine,    leftLine);
  const tr = lineIntersect(topLine,    rightLine);
  const br = lineIntersect(bottomLine, rightLine);
  const bl = lineIntersect(bottomLine, leftLine);

  if (!tl || !tr || !br || !bl) return null;

  // 화면을 크게 벗어난 교차점은 평행에 가깝거나 잘못된 라인 조합 → 거부
  const marginX = width  * 0.2;
  const marginY = height * 0.2;
  for (const corner of [tl, tr, br, bl]) {
    const x = corner[0] ?? 0;
    const y = corner[1] ?? 0;
    if (x < -marginX || x > width  + marginX) return null;
    if (y < -marginY || y > height + marginY) return null;
  }

  // 사각형 크기 게이트 — 너무 작으면 노이즈로 판단
  const quadW = Math.max(distance(tl, tr), distance(bl, br));
  const quadH = Math.max(distance(tl, bl), distance(tr, br));
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

function avgY(line: number[]): number {
  return ((line[1] ?? 0) + (line[3] ?? 0)) / 2;
}

function avgX(line: number[]): number {
  return ((line[0] ?? 0) + (line[2] ?? 0)) / 2;
}

function distance(p: number[], q: number[]): number {
  const dx = (q[0] ?? 0) - (p[0] ?? 0);
  const dy = (q[1] ?? 0) - (p[1] ?? 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 두 라인 세그먼트의 직선 교차점 계산.
 * 직선 일반형 (a·x + b·y = c) 기반. det ≈ 0 (평행) 시 null.
 */
function lineIntersect(l1: number[], l2: number[]): number[] | null {
  const x1 = l1[0] ?? 0, y1 = l1[1] ?? 0, x2 = l1[2] ?? 0, y2 = l1[3] ?? 0;
  const x3 = l2[0] ?? 0, y3 = l2[1] ?? 0, x4 = l2[2] ?? 0, y4 = l2[3] ?? 0;

  const a1 = y2 - y1;
  const b1 = x1 - x2;
  const c1 = a1 * x1 + b1 * y1;

  const a2 = y4 - y3;
  const b2 = x3 - x4;
  const c2 = a2 * x3 + b2 * y3;

  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;

  return [
    (b2 * c1 - b1 * c2) / det,
    (a1 * c2 - a2 * c1) / det,
  ];
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

/** Connected Components 결과에서 AR 오버레이용 텍스트 후보 폴리곤 추출 */
function collectTextRegions(
  stats: any,
  numLabels: number,
  width: number,
  height: number,
  homographyInv: any | null,
): BiosTextRegion[] {
  const candidates: BiosTextRegion[] = [];

  for (let i = 1; i <= numLabels; i++) {
    const x: number = stats.intAt(i, cv.CC_STAT_LEFT);
    const y: number = stats.intAt(i, cv.CC_STAT_TOP);
    const w: number = stats.intAt(i, cv.CC_STAT_WIDTH);
    const h: number = stats.intAt(i, cv.CC_STAT_HEIGHT);
    const area: number = stats.intAt(i, cv.CC_STAT_AREA);

    if (!isLikelyTextRegion({ w, h, area, width, height })) continue;

    const rectPoints: number[][] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    const points = homographyInv
      ? rectPoints.map(point => mapPointByHomography(point[0] ?? 0, point[1] ?? 0, homographyInv))
      : rectPoints;

    candidates.push({ id: i, area, points });
  }

  return candidates
    .sort((a, b) => b.area - a.area)
    .slice(0, 28);
}

function isLikelyTextRegion({
  w,
  h,
  area,
  width,
  height,
}: {
  w: number;
  h: number;
  area: number;
  width: number;
  height: number;
}): boolean {
  if (area < MIN_CC_AREA) return false;
  if (w < 4 || h < 4) return false;
  if (w > width * 0.75 || h > height * 0.25) return false;

  const ratio = w / Math.max(h, 1);
  return ratio >= 0.2 && ratio <= 18;
}

function mapPointByHomography(x: number, y: number, hInv: any): number[] {
  const h00: number = hInv.doubleAt(0, 0);
  const h01: number = hInv.doubleAt(0, 1);
  const h02: number = hInv.doubleAt(0, 2);
  const h10: number = hInv.doubleAt(1, 0);
  const h11: number = hInv.doubleAt(1, 1);
  const h12: number = hInv.doubleAt(1, 2);
  const h20: number = hInv.doubleAt(2, 0);
  const h21: number = hInv.doubleAt(2, 1);
  const h22: number = hInv.doubleAt(2, 2);
  const denom = h20 * x + h21 * y + h22;

  if (Math.abs(denom) < 1e-6) return [x, y];

  return [
    (h00 * x + h01 * y + h02) / denom,
    (h10 * x + h11 * y + h12) / denom,
  ];
}

/** OCR 텍스트 줄 분리 → 2~60자 항목만 추출 */
function extractMenuItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 2 && line.length <= 60);
}
