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
import type { GuideOcrRegion } from '../../types';

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

/** 4-모서리 검출 후보의 출처 — Gemini 프롬프트에 정면화 신뢰도를 명시할 때 사용 */
export type QuadSource = 'contour' | 'bright' | 'hough';

export interface BiosPipelineResult {
  rectified:   boolean;    // Homography 정면화 성공 여부
  ocrText:     string;     // Tesseract 전체 텍스트
  ocrRegions:  GuideOcrRegion[]; // OCR line/word 후보 영역 (원본 프레임 픽셀 공간)
  menuItems:   string[];   // 정리된 메뉴 항목 목록
  detectedVendor: BiosType | null; // OCR 텍스트에서 추론한 BIOS 제조사
  confidence:  number;     // OCR 신뢰도 0.0~1.0
  processingMs: number;    // 처리 시간 (ms)
}

export interface BiosGuidePreprocessResult {
  canvas: HTMLCanvasElement;
  rectified: boolean;
  /** 4 모서리 검출 후보 출처. 정면화 실패 시 null. Gemini 프롬프트에 신뢰도 단서로 노출. */
  rectificationSource: QuadSource | null;
  /** 0.0~1.0. 정면화 후보의 통합 점수 (areaRatio + centeredness + aspect + source bonus). */
  rectificationScore: number;
  textRegionCount: number;
  /** Connected Components 텍스트 후보 영역 (원본 프레임 픽셀 공간) */
  textRegions: BiosTextRegion[];
  processingMs: number;
  /** Hough 검출 4 모서리 좌표 (원본 프레임 픽셀 공간). [tl, tr, br, bl] 순서 */
  corners: number[][] | null;
  /** Canny edge map을 작은 썸네일(폭 EDGE_PREVIEW_W)로 다운샘플 후 data URL. CV 패널 미니 프리뷰용. */
  edgeMapDataUrl: string | null;
}

const EDGE_PREVIEW_W = 144;

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
const MIN_CC_AREA = 90;   // Connected Component 최소 픽셀 수
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
  let rectificationSource: QuadSource | null = null;
  let rectificationScore = 0;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 35, 120);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, HOUGH_VOTE, HOUGH_MIN, HOUGH_GAP);

    const corners = extractQuadCorners(gray, edges, lines, rgba.width, rgba.height);
    if (corners) {
      detectedCorners = corners.src;   // AR 오버레이용 — 원본 프레임 좌표
      rectificationSource = corners.source;
      rectificationScore = corners.score;
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
    const textRegions = collectTextRegions(
      stats,
      numLabels,
      rgba.width,
      rgba.height,
      homographyInv,
    );
    textRegionCount = textRegions.length;

    const canvas = document.createElement('canvas');
    canvas.width = rgba.width;
    canvas.height = rgba.height;
    cv.imshow(canvas, enhanced);

    // Canny edge map → 작은 썸네일 PNG (CV 패널 미니 프리뷰).
    // 원본 해상도로 그리지 않고 폭 EDGE_PREVIEW_W로 다운샘플 — 전송/저장 비용 최소화.
    let edgeMapDataUrl: string | null = null;
    try {
      const scale = EDGE_PREVIEW_W / Math.max(1, rgba.width);
      const previewW = Math.max(1, Math.round(rgba.width * scale));
      const previewH = Math.max(1, Math.round(rgba.height * scale));
      const previewMat = new cv.Mat();
      try {
        cv.resize(edges, previewMat, new cv.Size(previewW, previewH), 0, 0, cv.INTER_AREA);
        const previewCanvas = document.createElement('canvas');
        previewCanvas.width  = previewW;
        previewCanvas.height = previewH;
        cv.imshow(previewCanvas, previewMat);
        edgeMapDataUrl = previewCanvas.toDataURL('image/png');
      } finally {
        previewMat.delete();
      }
    } catch {
      edgeMapDataUrl = null;
    }

    return {
      canvas,
      rectified,
      rectificationSource,
      rectificationScore,
      textRegionCount,
      textRegions,
      processingMs: performance.now() - t0,
      corners: detectedCorners,
      edgeMapDataUrl,
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
  let   homographyInv: any = null;

  try {
    // ── Step 1: 그레이스케일 ────────────────────────────────────────────────
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // ── Step 2: Canny + HoughLinesP → 화면 경계 4 모서리 추출 ───────────────
    cv.Canny(gray, edges, 35, 120);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, HOUGH_VOTE, HOUGH_MIN, HOUGH_GAP);
    const corners = extractQuadCorners(gray, edges, lines, rgba.width, rgba.height);

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
    const textLineCount = collectTextRegions(stats, numLabels, rgba.width, rgba.height, null).length;
    void textLineCount; // ablation 분석용 (현재 OCR 입력 필터링 미구현)

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
    const ocrRegions = extractOcrRegions(data, rgba.width, rgba.height, homographyInv);
    const menuItems = extractMenuItems(ocrText);
    const detectedVendor = detectBiosVendor(ocrText);

    return {
      rectified,
      ocrText,
      ocrRegions,
      menuItems,
      detectedVendor,
      confidence,
      processingMs: performance.now() - t0,
    };
  } finally {
    [src, gray, edges, lines, enhanced, binary, labels, stats, centroids].forEach(m => m.delete());
    warped?.delete();
    homographyInv?.delete();
    clahe.delete();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface QuadCandidate {
  src: number[][];
  dst: number[][];
  source: QuadSource;
  score: number;
}

/**
 * 화면 4 모서리 추출 — 다중 후보 소스 + 통합 스코어링.
 *
 * 후보 소스:
 *   1) Contour — Canny edge → dilate/close (kernel 7·15) → findContours → approxPolyDP
 *   2) Bright Region — Otsu threshold → MORPH_CLOSE (kernel 21) → findContours
 *      모니터 베젤 안쪽이 주변보다 밝은 일반적 BIOS 촬영 환경에서 강건.
 *   3) Hough Lines — HoughLinesP h/v 분류 → 가장 바깥쪽 4개 교차점
 *
 * 통합 스코어링 (≈0..1+):
 *   - areaRatio:   화면 0.25~0.7 사이 가중
 *   - centeredness: 폴리곤 중심이 프레임 중심에 가까울수록 가산
 *   - aspect:      0.9~2.2 (4:3, 16:9 범위) 가중
 *   - sourceBonus: contour > bright > hough (먼저 검출되는 쪽이 보통 더 강건)
 *
 * 모든 후보가 임계점 이하면 null 반환 → 정면화 skip, Gemini에 `rectificationSource=null`로 전달.
 */
function extractQuadCorners(
  gray: any,
  edges: any,
  lines: any,
  width: number,
  height: number,
): QuadCandidate | null {
  const candidates: QuadCandidate[] = [];

  const contourCorners = extractQuadCornersFromContours(edges, width, height);
  if (contourCorners) {
    candidates.push({
      ...contourCorners,
      source: 'contour',
      score: scoreQuad(contourCorners.src, width, height) + 0.10,
    });
  }

  const brightCorners = extractQuadCornersFromBrightRegion(gray, width, height);
  if (brightCorners) {
    candidates.push({
      ...brightCorners,
      source: 'bright',
      score: scoreQuad(brightCorners.src, width, height) + 0.05,
    });
  }

  const houghCorners = extractQuadCornersFromLines(lines, width, height);
  if (houghCorners) {
    candidates.push({
      ...houghCorners,
      source: 'hough',
      score: scoreQuad(houghCorners.src, width, height),
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  // 최저 임계값 — 너무 낮은 점수는 잘못된 정면화로 OCR 정확도를 오히려 떨어뜨림.
  if (best.score < 0.35) return null;
  return best;
}

/**
 * 4 모서리 후보의 통합 점수 0..1.
 *
 * 기여:
 *   - 면적 비율 (target 0.4~0.7): 0..0.35
 *   - 중심 가까움 (target frame center): 0..0.20
 *   - aspect 비율 (1.1~2.2 범위): 0..0.20
 *
 * 외부 가산 (source bonus)을 더해 최종 비교 점수를 만든다.
 */
function scoreQuad(corners: number[][], width: number, height: number): number {
  const bounds = boundingBox(corners);
  const area = polygonArea(corners);
  const frameArea = width * height;
  const areaRatio = area / frameArea;

  // Area: 좋은 영역 [0.4, 0.7], 양쪽으로 갈수록 감점
  const areaScore = areaRatio < 0.25 ? Math.max(0, (areaRatio - 0.05) / 0.20) * 0.7
                  : areaRatio < 0.4 ? 0.7 + (areaRatio - 0.25) / 0.15 * 0.3
                  : areaRatio <= 0.7 ? 1
                  : Math.max(0, 1 - (areaRatio - 0.7) / 0.25);

  // 중심도
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  const dx = (centerX - width / 2) / width;
  const dy = (centerY - height / 2) / height;
  const centerScore = Math.max(0, 1 - Math.hypot(dx, dy) * 2.4);

  // Aspect
  const aspect = bounds.w / Math.max(bounds.h, 1);
  const aspectScore = aspect < 0.7 ? Math.max(0, aspect / 0.7)
                    : aspect <= 2.4 ? 1
                    : Math.max(0, 1 - (aspect - 2.4) / 1.5);

  return areaScore * 0.35 + centerScore * 0.20 + aspectScore * 0.20;
}

/**
 * 밝은 영역 기반 4 모서리 검출 (Otsu threshold + Morph close).
 * BIOS 촬영 환경에서 모니터 베젤 안쪽이 주변보다 밝거나 어두운 대비를 활용.
 * Canny edge가 텍스트 노이즈에 묻혀 contour를 만들지 못할 때의 보조 후보.
 */
function extractQuadCornersFromBrightRegion(
  gray: any,
  width: number,
  height: number,
): { src: number[][]; dst: number[][] } | null {
  const binary = new cv.Mat();
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(21, 21));

  try {
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = width * height;
    let best: { corners: number[][]; area: number } | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour);
        if (area < frameArea * 0.10 || area > frameArea * 0.95) continue;
        const perimeter = cv.arcLength(contour, true);
        for (const eps of [0.02, 0.03, 0.045, 0.06]) {
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(contour, approx, perimeter * eps, true);
            if (approx.rows !== 4) continue;
            const corners = matPointsToArray(approx);
            const result = makeQuadResult(corners, width, height);
            if (!result) continue;
            const polyArea = polygonArea(result.src);
            if (!best || polyArea > best.area) {
              best = { corners: result.src, area: polyArea };
            }
            break;
          } finally {
            approx.delete();
          }
        }
      } finally {
        contour.delete();
      }
    }

    return best ? makeQuadResult(best.corners, width, height) : null;
  } finally {
    binary.delete();
    closed.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

function makeQuadResult(corners: number[][], width: number, height: number): { src: number[][]; dst: number[][] } | null {
  const orderedCorners = orderCornersClockwise(corners);
  const [tl, tr, br, bl] = orderedCorners;

  const quadW = Math.max(distance(tl!, tr!), distance(bl!, br!));
  const quadH = Math.max(distance(tl!, bl!), distance(tr!, br!));
  if (quadW < width * 0.15 || quadH < height * 0.15) return null;
  if (!isConvexQuad(orderedCorners)) return null;

  const area = polygonArea(orderedCorners);
  const frameArea = width * height;
  if (area < frameArea * 0.08 || area > frameArea * 0.96) return null;

  return {
    src: orderedCorners,
    dst: [
      [0, 0],
      [width - 1, 0],
      [width - 1, height - 1],
      [0, height - 1],
    ],
  };
}

function extractQuadCornersFromContours(
  edges: any,
  width: number,
  height: number,
): { src: number[][]; dst: number[][] } | null {
  // 두 가지 morphology kernel을 모두 시도 — BIOS 텍스트는 작은 edge를 다수 만들어
  // 7px close로는 화면 contour가 끊김. 15px가 더 강건하나 작은 화면은 over-merge 위험.
  // 둘 다 결과 합치고 unified scoring에 맡긴다.
  const candidates: { corners: number[][]; score: number }[] = [];
  for (const kernelSize of [7, 15]) {
    const found = findContourQuadCandidates(edges, width, height, kernelSize);
    for (const c of found) candidates.push(c);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  return makeQuadResult(best.corners, width, height);
}

/** 단일 morphology kernel 크기에 대한 contour 후보 추출 */
function findContourQuadCandidates(
  edges: any,
  width: number,
  height: number,
  kernelSize: number,
): { corners: number[][]; score: number }[] {
  const work = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, kernelSize));

  const candidates: { corners: number[][]; score: number }[] = [];

  try {
    cv.dilate(edges, work, kernel, new cv.Point(-1, -1), 1);
    cv.morphologyEx(work, work, cv.MORPH_CLOSE, kernel);
    cv.findContours(work, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = width * height;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour);
        if (area < frameArea * 0.08 || area > frameArea * 0.96) continue;

        const perimeter = cv.arcLength(contour, true);
        for (const epsilonRatio of [0.015, 0.02, 0.03, 0.045]) {
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(contour, approx, perimeter * epsilonRatio, true);
            if (approx.rows !== 4) continue;

            const corners = matPointsToArray(approx);
            const result = makeQuadResult(corners, width, height);
            if (!result) continue;

            candidates.push({ corners: result.src, score: scoreQuad(result.src, width, height) });
          } finally {
            approx.delete();
          }
        }
      } finally {
        contour.delete();
      }
    }

    return candidates;
  } finally {
    work.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

function extractQuadCornersFromLines(
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
    // atan2 결과는 (-180°, 180°]. HoughLinesP의 endpoint 순서는 임의이므로
    // 오른쪽→왼쪽으로 그려진 수평선은 ~±180°가 되어 |angle|>70 검사로 vLines에 잘못 들어감.
    // [0, 90°]로 정규화한 다음 분류해야 수평/수직이 endpoint 순서와 무관하게 일관.
    const rawAngle = Math.abs(Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI));
    const angleDeg = rawAngle > 90 ? 180 - rawAngle : rawAngle;

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

  // 교차점 4개 (라벨은 임시 — 아래에서 좌표 기반으로 재정렬)
  const rawCorners = [
    lineIntersect(topLine,    leftLine),
    lineIntersect(topLine,    rightLine),
    lineIntersect(bottomLine, rightLine),
    lineIntersect(bottomLine, leftLine),
  ];

  if (rawCorners.some(c => c === null)) return null;

  // 화면을 크게 벗어난 교차점은 평행에 가깝거나 잘못된 라인 조합 → 거부
  const marginX = width  * 0.2;
  const marginY = height * 0.2;
  for (const corner of rawCorners) {
    const x = corner![0] ?? 0;
    const y = corner![1] ?? 0;
    if (x < -marginX || x > width  + marginX) return null;
    if (y < -marginY || y > height + marginY) return null;
  }

  // 좌표 기반 정규화 — 라인 분류/선택이 어긋났을 때도 폴리곤이 bowtie(X자)
  // 형태로 자기 교차되지 않도록 [TL, TR, BR, BL] CW 순으로 재정렬.
  // 트릭: TL은 x+y가 최소, BR은 x+y가 최대, TR은 x-y가 최대, BL은 x-y가 최소.
  const orderedCorners = orderCornersClockwise(rawCorners as number[][]);
  return makeQuadResult(orderedCorners, width, height);
}

/**
 * 4개의 임의 순서 좌표를 [TL, TR, BR, BL] CW 순으로 재배열.
 *   TL: x+y 최소  /  BR: x+y 최대
 *   TR: x-y 최대  /  BL: x-y 최소
 * 출처: PyImageSearch — 4-point perspective transform 튜토리얼.
 */
function orderCornersClockwise(points: number[][]): number[][] {
  let tl = points[0]!, br = points[0]!, tr = points[0]!, bl = points[0]!;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const p of points) {
    const sum  = (p[0] ?? 0) + (p[1] ?? 0);
    const diff = (p[0] ?? 0) - (p[1] ?? 0);
    if (sum  < minSum)  { minSum  = sum;  tl = p; }
    if (sum  > maxSum)  { maxSum  = sum;  br = p; }
    if (diff > maxDiff) { maxDiff = diff; tr = p; }
    if (diff < minDiff) { minDiff = diff; bl = p; }
  }
  return [tl, tr, br, bl];
}

function matPointsToArray(mat: any): number[][] {
  const points: number[][] = [];
  for (let i = 0; i < mat.rows; i++) {
    const offset = i * 2;
    const x = mat.data32S?.[offset] ?? mat.data32F?.[offset] ?? 0;
    const y = mat.data32S?.[offset + 1] ?? mat.data32F?.[offset + 1] ?? 0;
    points.push([x, y]);
  }
  return points;
}

function polygonArea(points: number[][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += ((a[0] ?? 0) * (b[1] ?? 0)) - ((b[0] ?? 0) * (a[1] ?? 0));
  }
  return Math.abs(area) / 2;
}

function boundingBox(points: number[][]): { x: number; y: number; w: number; h: number } {
  const xs = points.map(point => point[0] ?? 0);
  const ys = points.map(point => point[1] ?? 0);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 4 모서리가 단순(비교차) convex 사각형인지 검사 — 외적 부호 일치 확인 */
function isConvexQuad(corners: number[][]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const c = corners[(i + 2) % 4]!;
    const dx1 = (b[0] ?? 0) - (a[0] ?? 0);
    const dy1 = (b[1] ?? 0) - (a[1] ?? 0);
    const dx2 = (c[0] ?? 0) - (b[0] ?? 0);
    const dy2 = (c[1] ?? 0) - (b[1] ?? 0);
    const cross = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(cross) < 1e-3) continue;  // 거의 일직선 — 무시
    if (sign === 0) sign = cross > 0 ? 1 : -1;
    else if ((cross > 0 ? 1 : -1) !== sign) return false;
  }
  return true;
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

interface GlyphBox { x: number; y: number; w: number; h: number; area: number; }

/**
 * 글리프 후보로 적합한 single CC인지 검사 (line clustering 전 1차 필터).
 *
 * 목적: 425개에 달하던 raw CC 후보를 글자 크기/모양에 맞는 ~50~150개로 줄여
 *   다음 단계의 라인 클러스터링 비용·노이즈 감소.
 *
 * 거부:
 *   - 너무 작은 점/잡음   (h, w, area 하한)
 *   - 너무 큰 블롭        (화면 면적의 4% 이상 — 보더/배경 ROI)
 *   - 가로 줄·세로 줄     (극단적 aspect 비율)
 *   - 텍스트보다 너무 옅거나 진한 영역 (density)
 */
function isLikelyGlyphComponent(
  g: GlyphBox,
  frameW: number,
  frameH: number,
): boolean {
  if (g.area < Math.max(MIN_CC_AREA / 4, frameW * frameH * 0.0000125)) return false;
  if (g.w < 2 || g.h < 4) return false;
  if (g.h < frameH * 0.010 || g.h > frameH * 0.08) return false;
  if (g.w > frameW * 0.5) return false;
  if (g.area > frameW * frameH * 0.04) return false;

  const ratio = g.w / Math.max(g.h, 1);
  if (ratio > 14) return false;          // 가로 줄
  const density = g.area / Math.max(g.w * g.h, 1);
  if (density < 0.08 || density > 0.97) return false;
  return true;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

interface LineSegment { x: number; y: number; w: number; h: number; glyphCount: number; }

/**
 * 글리프 후보를 y-band 기준으로 라인 클러스터로 묶고, 라인 내 horizontal gap으로 segment 분할.
 *
 * 알고리즘:
 *   1) center-y로 정렬 후 greedy 클러스터링 (last cluster의 mean center-y와 비교).
 *   2) 라인 내에서 x로 정렬 후 인접 글리프 간 gap > median(width)*3.2 또는 line-height*2.4 이면 segment 분할.
 *   3) segment 별 bbox 병합 → line-level 박스.
 *
 * "Boot Option #1   [Enabled]" 같은 라벨·값 페어가 같은 줄에 있을 때
 * 둘은 클릭 단위가 다르므로 별도 segment로 분리되어야 한다.
 */
function clusterGlyphsIntoLines(glyphs: GlyphBox[]): LineSegment[] {
  if (!glyphs.length) return [];

  const sorted = [...glyphs].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const lines: { centerY: number; meanH: number; members: GlyphBox[] }[] = [];

  for (const g of sorted) {
    const cy = g.y + g.h / 2;
    const last = lines[lines.length - 1];
    const tolerance = Math.max(4, (last?.meanH ?? g.h) * 0.55);
    if (last && Math.abs(cy - last.centerY) <= tolerance) {
      last.members.push(g);
      const n = last.members.length;
      last.centerY = (last.centerY * (n - 1) + cy) / n;
      last.meanH = (last.meanH * (n - 1) + g.h) / n;
    } else {
      lines.push({ centerY: cy, meanH: g.h, members: [g] });
    }
  }

  const segments: LineSegment[] = [];
  for (const line of lines) {
    const members = [...line.members].sort((a, b) => a.x - b.x);
    if (!members.length) continue;
    const medianW = median(members.map(m => m.w));
    const gapThreshold = Math.max(medianW * 3.2, line.meanH * 2.4);

    let current: GlyphBox[] = [];
    const flush = () => {
      if (current.length < 2) {
        current = [];
        return;
      }
      const x0 = Math.min(...current.map(c => c.x));
      const y0 = Math.min(...current.map(c => c.y));
      const x1 = Math.max(...current.map(c => c.x + c.w));
      const y1 = Math.max(...current.map(c => c.y + c.h));
      segments.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, glyphCount: current.length });
      current = [];
    };

    for (const m of members) {
      if (!current.length) { current.push(m); continue; }
      const prev = current[current.length - 1]!;
      const gap = m.x - (prev.x + prev.w);
      if (gap > gapThreshold) flush();
      current.push(m);
    }
    flush();
  }

  return segments;
}

/**
 * Connected Components 결과를 글리프 → 라인 segment로 묶어 AR 오버레이/Gemini 매칭용 박스 추출.
 *
 * 결과:
 *   - 최대 30개 line-level 후보 (이전: 8개 raw CC) — Gemini가 normalized bbox로 직접 지목 가능.
 *   - 단일 문자/잡음 거부 (segment 당 ≥ 2 글리프, w >= 1.5*h, w <= frame*0.85)
 *   - reading order(top→bottom, left→right) 정렬.
 */
function collectTextRegions(
  stats: any,
  numLabels: number,
  width: number,
  height: number,
  homographyInv: any | null,
): BiosTextRegion[] {
  const glyphs: GlyphBox[] = [];

  for (let i = 1; i <= numLabels; i++) {
    const x: number = stats.intAt(i, cv.CC_STAT_LEFT);
    const y: number = stats.intAt(i, cv.CC_STAT_TOP);
    const w: number = stats.intAt(i, cv.CC_STAT_WIDTH);
    const h: number = stats.intAt(i, cv.CC_STAT_HEIGHT);
    const area: number = stats.intAt(i, cv.CC_STAT_AREA);
    const candidate: GlyphBox = { x, y, w, h, area };
    if (!isLikelyGlyphComponent(candidate, width, height)) continue;
    glyphs.push(candidate);
  }

  const segments = clusterGlyphsIntoLines(glyphs);
  const lines: BiosTextRegion[] = [];

  segments.forEach((seg, idx) => {
    // 라인 단위 후처리 필터
    if (seg.w < seg.h * 1.5) return;            // 거의 정사각형 → 라인이 아님 (아이콘/번호)
    if (seg.w > width * 0.85) return;            // 화면 전체 가로지름 → 보더/스트라이프 잡음
    if (seg.h < height * 0.010) return;          // 너무 얇음
    if (seg.h > height * 0.10) return;           // 너무 큼 (라벨 아닌 큰 블롭 모임)
    if (seg.glyphCount < 2) return;

    const rectPoints: number[][] = [
      [seg.x, seg.y],
      [seg.x + seg.w, seg.y],
      [seg.x + seg.w, seg.y + seg.h],
      [seg.x, seg.y + seg.h],
    ];
    const points = homographyInv
      ? rectPoints.map(point => mapPointByHomography(point[0] ?? 0, point[1] ?? 0, homographyInv))
      : rectPoints;

    lines.push({ id: idx + 1, area: seg.w * seg.h, points });
  });

  // reading order: top → bottom, 같은 y-band면 left → right
  return lines
    .sort((a, b) => {
      const ay = a.points[0]?.[1] ?? 0;
      const by = b.points[0]?.[1] ?? 0;
      if (Math.abs(ay - by) > 12) return ay - by;
      return (a.points[0]?.[0] ?? 0) - (b.points[0]?.[0] ?? 0);
    })
    .slice(0, 30);
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

/**
 * Tesseract 결과에서 라인 단위 OCR 후보만 추출.
 *
 * 설계 원칙:
 *   - BIOS/설치 화면은 메뉴/버튼이 라인 단위로 클릭됨 → 단어 단위 후보 미사용.
 *     word 후보를 함께 보내면 Gemini가 "Boot" 단어 하나를 찍어버려 "Boot Option #1"
 *     라인 전체를 가리키지 못한다. 라인만 보내면 클릭 단위와 1:1 매칭.
 *   - 신뢰도·의미문자 비율 필터로 노이즈(짧은 기호·OCR 잡음) 제거.
 *   - OK/F10/ESC 같은 짧은 BIOS 액션은 예외적으로 보존.
 *   - 최대 50개로 절단 — 백엔드 프롬프트 토큰 절약.
 */
function extractOcrRegions(
  // Tesseract.js Page 타입은 런타임 버전별로 optional 필드가 있어 any로 좁게 처리.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  width: number,
  height: number,
  homographyInv: any | null,
): GuideOcrRegion[] {
  const regions: GuideOcrRegion[] = [];
  let lineId = 0;

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const lineText = normalizeOcrText(line.text);
        if (!isLikelyClickableText(lineText)) continue;
        const region = makeOcrRegion(
          `ocr-line-${lineId++}`,
          lineText,
          line.confidence ?? 0,
          line.bbox,
          width,
          height,
          homographyInv,
        );
        if (region) regions.push(region);
      }
    }
  }

  return regions
    // BIOS 화면은 반사·저대비로 Tesseract 신뢰도가 자주 0.3~0.5에 머무름.
    // 0.5 컷오프는 "Boot Option #1" 같은 핵심 메뉴 라인을 떨궈서 overlay 매칭 실패 유발 →
    // 0.3로 완화 + 의미 있는 짧은 액션 fallback. 백엔드 텍스트 매칭이 추가 안전망 역할.
    .filter(region => region.confidence >= 0.3 || isLikelyClickableText(region.text))
    .sort((a, b) => {
      const ay = a.bbox.y;
      const by = b.bbox.y;
      if (Math.abs(ay - by) > 12) return ay - by;
      return a.bbox.x - b.bbox.x;
    })
    .slice(0, 50);
}

/**
 * 클릭 가능성이 있는 텍스트인지 휴리스틱 검사.
 * - 일반 텍스트는 길이 ≥ 3
 * - OK/Yes/No/F1~F12/ESC 같은 짧은 BIOS 액션은 허용
 * - 영문자 또는 숫자가 최소 2자
 * - 알파뉴메릭+공백 비율 ≥ 0.6 (특수문자만 있는 OCR 잡음 거부)
 */
export function isLikelyClickableText(text: string): boolean {
  const normalized = text.trim();
  if (/^(ok|yes|no|esc|del|f(?:1[0-2]|[1-9]))$/i.test(normalized)) return true;
  if (normalized.length < 3) return false;
  const alnum = normalized.match(/[A-Za-z0-9가-힣]/g)?.length ?? 0;
  if (alnum < 2) return false;
  const meaningful = normalized.match(/[A-Za-z0-9가-힣 ]/g)?.length ?? 0;
  return meaningful / normalized.length >= 0.6;
}

function makeOcrRegion(
  id: string,
  text: string,
  confidence: number,
  bbox: { x0: number; y0: number; x1: number; y1: number } | null | undefined,
  width: number,
  height: number,
  homographyInv: any | null,
): GuideOcrRegion | null {
  if (!bbox) return null;
  const rectPoints: number[][] = [
    [bbox.x0, bbox.y0],
    [bbox.x1, bbox.y0],
    [bbox.x1, bbox.y1],
    [bbox.x0, bbox.y1],
  ];
  const points = homographyInv
    ? rectPoints.map(point => mapPointByHomography(point[0] ?? 0, point[1] ?? 0, homographyInv))
    : rectPoints;

  const xs = points.map(point => point[0] ?? 0);
  const ys = points.map(point => point[1] ?? 0);
  const x0 = clamp(Math.min(...xs), 0, width);
  const y0 = clamp(Math.min(...ys), 0, height);
  const x1 = clamp(Math.max(...xs), 0, width);
  const y1 = clamp(Math.max(...ys), 0, height);
  const w = x1 - x0;
  const h = y1 - y0;

  if (w < 3 || h < 3) return null;

  return {
    id,
    text,
    confidence: Math.max(0, Math.min(1, confidence / 100)),
    bbox: { x: x0, y: y0, w, h },
    points,
  };
}

function normalizeOcrText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** OCR 텍스트 줄 분리 → 2~60자 항목만 추출 */
function extractMenuItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 2 && line.length <= 60);
}
