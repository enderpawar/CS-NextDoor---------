"""Evaluate the real-capture BIOS OpenCV test package.

Inputs:
  - data/bios/real-capture/ground-truth.csv
  - raw images referenced by the filename column
  - or external images in REAL_CAPTURE_IMAGE_DIR / --image-dir
  - optional data/live-frames/real-video-ground-truth.csv

Outputs:
  - docs/ablation-results/real-bios-quality-results.csv
  - docs/ablation-results/real-bios-corner-results.csv
  - docs/ablation-results/real-bios-ocr-results.csv
  - docs/ablation-results/real-video-frame-results.csv
  - docs/ablation-results/real-bios-summary.csv
  - docs/cv-pipeline/real-bios-detection-gallery.png
  - docs/cv-pipeline/real-bios-summary-chart.svg
  - docs/cv-pipeline/real-bios-overlay-grid.png
  - docs/cv-pipeline/real-bios-preprocess-comparison.png
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import argparse
import csv
import difflib
import math
import re
from typing import Iterable

import cv2
import numpy as np

try:
    import pytesseract
except Exception:  # pragma: no cover - optional local dependency
    pytesseract = None


ROOT = Path.cwd().resolve()
if ROOT.name == "notebooks":
    ROOT = ROOT.parent

DATA_DIR = ROOT / "data"
BIOS_GT = DATA_DIR / "bios" / "real-capture" / "ground-truth.csv"
DEFAULT_EXTERNAL_IMAGE_DIR = Path(r"C:\Users\user\Desktop\test data")
VIDEO_GT = DATA_DIR / "live-frames" / "real-video-ground-truth.csv"
ABLATION_DIR = ROOT / "docs" / "ablation-results"
PIPELINE_DIR = ROOT / "docs" / "cv-pipeline"
DETECTION_GALLERY_PNG = PIPELINE_DIR / "real-bios-detection-gallery.png"
OVERLAY_GRID_PNG = PIPELINE_DIR / "real-bios-overlay-grid.png"
PREPROCESS_COMPARISON_PNG = PIPELINE_DIR / "real-bios-preprocess-comparison.png"
SUMMARY_CHART_SVG = PIPELINE_DIR / "real-bios-summary-chart.svg"

ABLATION_DIR.mkdir(parents=True, exist_ok=True)
PIPELINE_DIR.mkdir(parents=True, exist_ok=True)

MIN_SHARPNESS = 0.05
MIN_BRIGHTNESS = 0.15
MAX_BRIGHTNESS = 0.85


@dataclass
class ImageEval:
    path: Path
    row: dict[str, str]
    image: np.ndarray
    gray: np.ndarray
    processed: np.ndarray
    corners: np.ndarray | None
    line_count: int
    corner_method: str
    text_boxes: list[tuple[int, int, int, int]]
    quality: dict[str, float | bool | str]


def normalize_text(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9가-힣]+", " ", value or "")
    return re.sub(r"\s+", " ", value).strip().lower()


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, normalize_text(a), normalize_text(b)).ratio()


def load_image(path: Path) -> np.ndarray | None:
    if not path.exists():
        return None
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    return image


def quality_metrics(gray: np.ndarray, label: str, defect_type: str) -> dict[str, float | bool | str]:
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    lap_var = float(lap.var())
    sharpness = min(1.0, lap_var / 1600.0)
    norm = gray.astype(np.float32) / 255.0
    brightness_mean = float(norm.mean())
    brightness_std = float(norm.std())
    is_usable = sharpness >= MIN_SHARPNESS and MIN_BRIGHTNESS <= brightness_mean <= MAX_BRIGHTNESS
    predicted_label = "good" if is_usable else "bad"
    return {
        "label": label,
        "defect_type": defect_type,
        "laplacian_variance": lap_var,
        "sharpness_score": sharpness,
        "brightness_mean": brightness_mean,
        "brightness_std": brightness_std,
        "is_usable": bool(is_usable),
        "predicted_label": predicted_label,
    }


def preprocess_for_ocr(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    thresholded = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        11,
        2,
    )
    return gray, thresholded


def detect_corners(gray: np.ndarray) -> tuple[np.ndarray | None, int, float, str]:
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80, minLineLength=80, maxLineGap=12)
    line_count = 0 if lines is None else int(len(lines))

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return fallback_roi(gray, line_count)

    image_area = gray.shape[0] * gray.shape[1]
    candidates: list[tuple[float, np.ndarray]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.08:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4:
            candidates.append((area, approx.reshape(4, 2)))

    if not candidates:
        return fallback_roi(gray, line_count)

    area, corners = max(candidates, key=lambda item: item[0])
    return corners.astype(np.float32), line_count, float(area / image_area), "strict-quad"


def fallback_roi(gray: np.ndarray, line_count: int) -> tuple[np.ndarray | None, int, float, str]:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 17))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, line_count, 0.0, "none"

    image_area = gray.shape[0] * gray.shape[1]
    boxes: list[tuple[float, int, int, int, int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area_ratio = (w * h) / image_area
        aspect = w / max(1, h)
        if 0.12 <= area_ratio <= 0.95 and 1.2 <= aspect <= 5.8:
            boxes.append((area_ratio, x, y, w, h))

    if not boxes:
        return None, line_count, 0.0, "none"

    area_ratio, x, y, w, h = max(boxes, key=lambda item: item[0])
    corners = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float32)
    return corners, line_count, float(area_ratio), "fallback-roi"


def detect_text_boxes(binary: np.ndarray) -> list[tuple[int, int, int, int]]:
    # Tesseract 없이도 전처리 결과가 텍스트형 connected component를 얼마나 분리하는지 보여준다.
    inverted = 255 - binary
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 2))
    merged = cv2.morphologyEx(inverted, cv2.MORPH_CLOSE, kernel, iterations=1)
    num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(merged, 8)
    boxes: list[tuple[int, int, int, int]] = []
    image_area = binary.shape[0] * binary.shape[1]
    min_h = max(10, int(binary.shape[0] * 0.006))
    max_h = max(42, int(binary.shape[0] * 0.07))
    min_w = max(12, int(binary.shape[1] * 0.004))
    max_w = max(220, int(binary.shape[1] * 0.28))
    for label in range(1, num_labels):
        x, y, w, h, area = stats[label]
        if area < 120 or area > image_area * 0.02:
            continue
        aspect = w / max(1, h)
        fill_ratio = area / max(1, w * h)
        if min_w <= w <= max_w and min_h <= h <= max_h and 0.25 <= aspect <= 18 and 0.05 <= fill_ratio <= 0.85:
            boxes.append((int(x), int(y), int(w), int(h)))
    return boxes


def ocr_text(image: np.ndarray) -> tuple[str, bool]:
    if pytesseract is None:
        return "", False
    try:
        return pytesseract.image_to_string(image, config="--psm 6"), True
    except Exception:
        return "", False


def infer_row_from_external_file(path: Path, index: int) -> dict[str, str]:
    name = path.stem.lower()
    has_popup = "popup" in name or "option" in name or index >= 11
    screen_id = "boot-popup" if has_popup else "boot-main"
    expected = (
        "Boot Option UEFI CD DVD UEFI Hard Disk Windows Boot Manager UEFI USB Disabled"
        if has_popup
        else "MSI Click BIOS 5 Settings Boot Boot Option"
    )
    return {
        "filename": str(path),
        "screen_id": screen_id,
        "vendor": "ami",
        "angle_deg": "0",
        "lighting": "unknown",
        "distance": "unknown",
        "defect_type": "real-capture",
        "label": "good",
        "expected_text": expected,
        "notes": "auto-discovered from external test data folder; refine labels after manual review",
    }


def image_path_for_row(row: dict[str, str], image_dir: Path | None) -> Path:
    filename = str(row["filename"])
    candidate = Path(filename)
    if candidate.is_absolute():
        return candidate
    if image_dir is not None:
        return image_dir / candidate.name
    return DATA_DIR / "bios" / candidate


def iter_bios_evals(image_dir: Path | None = None) -> Iterable[ImageEval]:
    if not BIOS_GT.exists():
        return []

    rows = read_csv_dicts(BIOS_GT)
    if image_dir is not None and image_dir.exists():
        external_files = sorted(
            list(image_dir.glob("*.jpg")) +
            list(image_dir.glob("*.jpeg")) +
            list(image_dir.glob("*.png")),
        )
        if external_files:
            rows = [infer_row_from_external_file(path, index) for index, path in enumerate(external_files)]

    evals: list[ImageEval] = []
    for row in rows:
        path = image_path_for_row(row, image_dir)
        image = load_image(path)
        if image is None:
            continue
        gray, processed = preprocess_for_ocr(image)
        corners, line_count, _area_ratio, corner_method = detect_corners(gray)
        text_boxes = detect_text_boxes(processed)
        quality = quality_metrics(gray, str(row["label"]), str(row["defect_type"]))
        evals.append(ImageEval(path, row, image, gray, processed, corners, line_count, corner_method, text_boxes, quality))
    return evals


def read_csv_dicts(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def write_csv_dicts(path: Path, rows: list[dict[str, object]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def save_empty_outputs() -> None:
    write_csv_dicts(ABLATION_DIR / "real-bios-quality-results.csv", [], [
        "filename", "screen_id", "label", "defect_type", "laplacian_variance",
        "sharpness_score", "brightness_mean", "brightness_std", "is_usable", "predicted_label",
    ])
    write_csv_dicts(ABLATION_DIR / "real-bios-corner-results.csv", [], [
        "filename", "screen_id", "angle_deg", "defect_type", "corner_detected",
        "quad_area_ratio", "line_count", "corner_method", "text_roi_count", "mean_iou", "notes",
    ])
    write_csv_dicts(ABLATION_DIR / "real-bios-ocr-results.csv", [], [
        "filename", "screen_id", "defect_type", "raw_similarity", "processed_similarity",
        "accuracy_at_0_8", "ocr_available", "raw_text", "processed_text",
    ])


def evaluate_bios_images(image_dir: Path | None = None) -> None:
    evals = list(iter_bios_evals(image_dir))
    if not evals:
        save_empty_outputs()
        write_no_data_summary_svg(image_dir)
        detail = f" in {image_dir}" if image_dir is not None else ""
        print(f"No real-capture BIOS images found{detail}. Add files referenced by data/bios/real-capture/ground-truth.csv.")
        return

    quality_rows = []
    corner_rows = []
    ocr_rows = []

    for item in evals:
        filename = str(Path(item.row["filename"]).as_posix())
        screen_id = str(item.row["screen_id"])
        expected = str(item.row["expected_text"])
        raw_text, raw_ok = ocr_text(item.gray)
        processed_text, processed_ok = ocr_text(item.processed)
        raw_sim = similarity(raw_text, expected) if raw_ok else math.nan
        processed_sim = similarity(processed_text, expected) if processed_ok else math.nan
        ocr_available = raw_ok or processed_ok

        quality_rows.append({
            "filename": filename,
            "screen_id": screen_id,
            **item.quality,
        })
        corner_rows.append({
            "filename": filename,
            "screen_id": screen_id,
            "angle_deg": item.row["angle_deg"],
            "defect_type": item.row["defect_type"],
            "corner_detected": item.corners is not None,
            "quad_area_ratio": polygon_area_ratio(item.corners, item.gray.shape) if item.corners is not None else 0.0,
            "line_count": item.line_count,
            "corner_method": item.corner_method,
            "text_roi_count": len(item.text_boxes),
            "mean_iou": math.nan,
            "notes": "IoU requires optional manual corner annotations.",
        })
        ocr_rows.append({
            "filename": filename,
            "screen_id": screen_id,
            "defect_type": item.row["defect_type"],
            "raw_similarity": raw_sim,
            "processed_similarity": processed_sim,
            "accuracy_at_0_8": bool(processed_sim >= 0.8) if processed_ok else False,
            "ocr_available": ocr_available,
            "raw_text": normalize_text(raw_text),
            "processed_text": normalize_text(processed_text),
        })

    write_csv_dicts(ABLATION_DIR / "real-bios-quality-results.csv", quality_rows, [
        "filename", "screen_id", "label", "defect_type", "laplacian_variance",
        "sharpness_score", "brightness_mean", "brightness_std", "is_usable", "predicted_label",
    ])
    write_csv_dicts(ABLATION_DIR / "real-bios-corner-results.csv", corner_rows, [
        "filename", "screen_id", "angle_deg", "defect_type", "corner_detected",
        "quad_area_ratio", "line_count", "corner_method", "text_roi_count", "mean_iou", "notes",
    ])
    write_csv_dicts(ABLATION_DIR / "real-bios-ocr-results.csv", ocr_rows, [
        "filename", "screen_id", "defect_type", "raw_similarity", "processed_similarity",
        "accuracy_at_0_8", "ocr_available", "raw_text", "processed_text",
    ])
    write_summary_csv(quality_rows, corner_rows, ocr_rows)
    save_detection_gallery(evals)
    save_overlay_grid(evals)
    save_preprocess_comparison(evals)

    print(f"Evaluated {len(evals)} BIOS real-capture images.")


def write_summary_csv(
    quality_rows: list[dict[str, object]],
    corner_rows: list[dict[str, object]],
    ocr_rows: list[dict[str, object]],
) -> None:
    n = len(quality_rows)
    if n == 0:
        write_csv_dicts(ABLATION_DIR / "real-bios-summary.csv", [], ["metric", "value", "notes"])
        return

    usable = sum(str(r["is_usable"]).lower() == "true" for r in quality_rows)
    rejected = n - usable
    sharpness = [float(r["sharpness_score"]) for r in quality_rows]
    laplacian = [float(r["laplacian_variance"]) for r in quality_rows]
    brightness = [float(r["brightness_mean"]) for r in quality_rows]
    corner_detected = sum(str(r["corner_detected"]).lower() == "true" for r in corner_rows)
    fallback = sum(str(r["corner_method"]) == "fallback-roi" for r in corner_rows)
    strict = sum(str(r["corner_method"]) == "strict-quad" for r in corner_rows)
    lines = [int(r["line_count"]) for r in corner_rows]
    text_counts = [int(r["text_roi_count"]) for r in corner_rows]
    ocr_available = sum(str(r["ocr_available"]).lower() == "true" for r in ocr_rows)

    rows = [
        {"metric": "Real-capture still images", "value": n, "notes": "External test data folder"},
        {"metric": "Quality gate accepted", "value": f"{usable}/{n} ({usable / n:.1%})", "notes": "Laplacian + brightness thresholds"},
        {"metric": "Quality gate rejected", "value": f"{rejected}/{n} ({rejected / n:.1%})", "notes": "Blur/reflection/low-detail stress frames filtered"},
        {"metric": "Mean sharpness score", "value": f"{average(sharpness):.3f}", "notes": f"range {min(sharpness):.3f}-{max(sharpness):.3f}"},
        {"metric": "Mean Laplacian variance", "value": f"{average(laplacian):.1f}", "notes": f"range {min(laplacian):.1f}-{max(laplacian):.1f}"},
        {"metric": "Mean brightness", "value": f"{average(brightness):.3f}", "notes": f"range {min(brightness):.3f}-{max(brightness):.3f}"},
        {"metric": "ROI/corner detection", "value": f"{corner_detected}/{n} ({corner_detected / n:.1%})", "notes": f"strict={strict}, fallback={fallback}"},
        {"metric": "Mean Hough line candidates", "value": f"{average(lines):.1f}", "notes": f"range {min(lines)}-{max(lines)}"},
        {"metric": "Mean text ROI candidates", "value": f"{average(text_counts):.1f}", "notes": f"range {min(text_counts)}-{max(text_counts)}"},
        {"metric": "OCR availability", "value": f"{ocr_available}/{n} ({ocr_available / n:.1%})", "notes": "Requires local Tesseract/pytesseract"},
    ]
    write_csv_dicts(ABLATION_DIR / "real-bios-summary.csv", rows, ["metric", "value", "notes"])
    write_summary_chart_svg(n, usable, rejected, corner_detected, ocr_available, average(sharpness), average(laplacian), average(text_counts))


def write_summary_chart_svg(
    n: int,
    usable: int,
    rejected: int,
    roi_detected: int,
    ocr_available: int,
    mean_sharpness: float,
    mean_laplacian: float,
    mean_text_roi: float,
) -> None:
    def pct(value: int) -> float:
        return value / n if n else 0.0

    bars = [
        ("Quality pass", usable, "#2563eb"),
        ("Quality reject", rejected, "#ef4444"),
        ("ROI detected", roi_detected, "#14b8a6"),
        ("OCR measured", ocr_available, "#94a3b8"),
    ]
    bar_rows = []
    for i, (label, value, color) in enumerate(bars):
        y = 140 + i * 62
        width = int(480 * pct(value))
        bar_rows.append(f"""
  <text x="70" y="{y + 22}" font-family="Arial, sans-serif" font-size="18" fill="#334155">{label}</text>
  <rect x="240" y="{y}" width="480" height="30" rx="8" fill="#e5e7eb"/>
  <rect x="240" y="{y}" width="{width}" height="30" rx="8" fill="{color}"/>
  <text x="742" y="{y + 22}" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#111827">{value}/{n} ({pct(value):.1%})</text>
""")

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="520" viewBox="0 0 1040 520">
  <rect width="1040" height="520" rx="18" fill="#ffffff"/>
  <text x="64" y="58" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#111827">Real-Capture OpenCV Evaluation Summary</text>
  <text x="64" y="92" font-family="Arial, sans-serif" font-size="16" fill="#64748b">{n} real camera BIOS frames from C:\\Users\\user\\Desktop\\test data</text>
  {''.join(bar_rows)}
  <rect x="64" y="408" width="912" height="76" rx="14" fill="#f8fafc" stroke="#cbd5e1"/>
  <text x="92" y="438" font-family="Arial, sans-serif" font-size="17" fill="#334155">Mean sharpness: {mean_sharpness:.3f}</text>
  <text x="340" y="438" font-family="Arial, sans-serif" font-size="17" fill="#334155">Mean Laplacian variance: {mean_laplacian:.1f}</text>
  <text x="680" y="438" font-family="Arial, sans-serif" font-size="17" fill="#334155">Mean text/edge ROI: {mean_text_roi:.1f}</text>
  <text x="92" y="466" font-family="Arial, sans-serif" font-size="14" fill="#64748b">OCR is marked as unmeasured because local Tesseract/pytesseract is not installed in this environment.</text>
</svg>
"""
    SUMMARY_CHART_SVG.write_text(svg, encoding="utf-8")


def write_no_data_summary_svg(image_dir: Path | None) -> None:
    source = str(image_dir) if image_dir is not None else "data/bios/real-capture"
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="360" viewBox="0 0 1040 360">
  <rect width="1040" height="360" rx="18" fill="#ffffff"/>
  <text x="64" y="70" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#111827">Real-Capture OpenCV Evaluation Summary</text>
  <text x="64" y="116" font-family="Arial, sans-serif" font-size="18" fill="#64748b">No image files were found in {source}.</text>
  <rect x="64" y="160" width="912" height="92" rx="14" fill="#f8fafc" stroke="#cbd5e1"/>
  <text x="92" y="198" font-family="Arial, sans-serif" font-size="16" fill="#334155">Run:</text>
  <text x="142" y="198" font-family="Consolas, monospace" font-size="16" fill="#111827">python notebooks/evaluate_real_capture_dataset.py --image-dir "C:\\Users\\user\\Desktop\\test data"</text>
  <text x="92" y="228" font-family="Arial, sans-serif" font-size="14" fill="#64748b">This file is a status chart, not an evaluation gallery. Real overlays are generated only when images are present.</text>
</svg>
"""
    SUMMARY_CHART_SVG.write_text(svg, encoding="utf-8")


def average(values: list[float | int]) -> float:
    return float(sum(values) / len(values)) if values else math.nan


def polygon_area_ratio(corners: np.ndarray, shape: tuple[int, ...]) -> float:
    area = abs(float(cv2.contourArea(corners.reshape(-1, 1, 2))))
    return area / float(shape[0] * shape[1])


def draw_corners(image: np.ndarray, corners: np.ndarray | None) -> np.ndarray:
    out = image.copy()
    if corners is not None:
        pts = corners.astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(out, [pts], True, (0, 255, 0), 3)
    return out


def draw_detection_overlay(item: ImageEval) -> np.ndarray:
    out = item.image.copy()
    is_usable = bool(item.quality["is_usable"])
    tone = (40, 190, 80) if is_usable else (40, 80, 230)
    if item.corners is not None:
        pts = item.corners.astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(out, [pts], True, (0, 220, 120), 5)

    # Draw a capped subset to keep the gallery readable.
    for x, y, w, h in item.text_boxes[:80]:
        cv2.rectangle(out, (x, y), (x + w, y + h), (255, 180, 40), 2)

    label = "PASS" if is_usable else "REJECT"
    caption = (
        f"{label} | sharp={float(item.quality['sharpness_score']):.3f} "
        f"| lines={item.line_count} | textROI={len(item.text_boxes)} | {item.corner_method}"
    )
    draw_label(out, caption, tone)
    return out


def draw_label(image: np.ndarray, text: str, color: tuple[int, int, int]) -> None:
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = max(0.7, image.shape[1] / 2400)
    thickness = max(2, int(round(scale * 2)))
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thickness)
    cv2.rectangle(image, (18, 18), (36 + tw, 36 + th + baseline), (20, 20, 20), -1)
    cv2.rectangle(image, (18, 18), (36 + tw, 36 + th + baseline), color, 3)
    cv2.putText(image, text, (28, 28 + th), font, scale, (255, 255, 255), thickness, cv2.LINE_AA)


def resize_to_tile(image: np.ndarray, width: int, height: int) -> np.ndarray:
    h, w = image.shape[:2]
    scale = min(width / w, height / h)
    resized = cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    tile = np.full((height, width, 3), 245, dtype=np.uint8)
    y = (height - resized.shape[0]) // 2
    x = (width - resized.shape[1]) // 2
    if resized.ndim == 2:
        resized = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
    tile[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return tile


def resize_cover(image: np.ndarray, width: int, height: int) -> np.ndarray:
    h, w = image.shape[:2]
    scale = max(width / w, height / h)
    resized = cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    y = max(0, (resized.shape[0] - height) // 2)
    x = max(0, (resized.shape[1] - width) // 2)
    crop = resized[y:y + height, x:x + width]
    if crop.shape[0] != height or crop.shape[1] != width:
        return resize_to_tile(image, width, height)
    return crop


def save_overlay_grid(evals: list[ImageEval]) -> None:
    if not evals:
        return
    selected = evals[: min(12, len(evals))]
    tile_w, tile_h = 430, 280
    cols = 3
    rows = []
    tiles = []
    for item in selected:
        overlay = draw_detection_overlay(item)
        tiles.append(resize_cover(overlay, tile_w, tile_h))
    while len(tiles) % cols != 0:
        tiles.append(np.full((tile_h, tile_w, 3), 245, dtype=np.uint8))
    for i in range(0, len(tiles), cols):
        rows.append(np.hstack(tiles[i:i + cols]))
    header = np.full((82, tile_w * cols, 3), 255, dtype=np.uint8)
    cv2.putText(header, "BIOS ROI and Text-Candidate Overlay", (24, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.92, (30, 36, 49), 2, cv2.LINE_AA)
    cv2.putText(header, "Green: BIOS ROI candidate / Orange: text-like connected components / PASS-REJECT: quality gate", (24, 64), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (90, 98, 116), 1, cv2.LINE_AA)
    grid = np.vstack([header, *rows])
    cv2.imwrite(str(OVERLAY_GRID_PNG), grid)


def save_preprocess_comparison(evals: list[ImageEval]) -> None:
    if not evals:
        return
    selected = evals[: min(6, len(evals))]
    tile_w, tile_h = 430, 280
    rows = []
    for item in selected:
        raw = item.image.copy()
        draw_label(raw, "Raw camera frame", (90, 120, 240))
        processed = cv2.cvtColor(item.processed, cv2.COLOR_GRAY2BGR)
        draw_label(processed, "CLAHE + Adaptive Threshold", (90, 120, 240))
        rows.append(np.hstack([resize_cover(raw, tile_w, tile_h), resize_cover(processed, tile_w, tile_h)]))
    header = np.full((82, tile_w * 2, 3), 255, dtype=np.uint8)
    cv2.putText(header, "Preprocessing Before / After", (24, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.92, (30, 36, 49), 2, cv2.LINE_AA)
    cv2.putText(header, "Left: raw real-capture input / Right: contrast-normalized binary image for OCR or vision model input", (24, 64), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (90, 98, 116), 1, cv2.LINE_AA)
    grid = np.vstack([header, *rows])
    cv2.imwrite(str(PREPROCESS_COMPARISON_PNG), grid)


def save_detection_gallery(evals: list[ImageEval]) -> None:
    if not evals:
        return
    selected = evals[: min(12, len(evals))]
    tile_w, tile_h = 620, 310
    rows = []
    for item in selected:
        raw = item.image.copy()
        draw_label(raw, Path(item.path).name, (90, 120, 240))
        overlay = draw_detection_overlay(item)
        processed = cv2.cvtColor(item.processed, cv2.COLOR_GRAY2BGR)
        draw_label(processed, "CLAHE + Adaptive Threshold", (90, 120, 240))
        row = np.hstack([
            resize_to_tile(raw, tile_w, tile_h),
            resize_to_tile(overlay, tile_w, tile_h),
            resize_to_tile(processed, tile_w, tile_h),
        ])
        rows.append(row)

    header = np.full((86, tile_w * 3, 3), 255, dtype=np.uint8)
    cv2.putText(header, "Real BIOS OpenCV Detection Gallery", (26, 36), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (30, 36, 49), 2, cv2.LINE_AA)
    cv2.putText(header, "Raw frame | ROI + text candidates | CLAHE + Adaptive Threshold", (26, 68), cv2.FONT_HERSHEY_SIMPLEX, 0.68, (90, 98, 116), 2, cv2.LINE_AA)
    gallery = np.vstack([header, *rows])
    cv2.imwrite(str(DETECTION_GALLERY_PNG), gallery)


def evaluate_video_frames() -> None:
    if not VIDEO_GT.exists():
        return
    rows = []
    previous_gray: np.ndarray | None = None

    for row in read_csv_dicts(VIDEO_GT):
        video_path = DATA_DIR / "live-frames" / str(row["video_filename"])
        if not video_path.exists():
            continue
        cap = cv2.VideoCapture(str(video_path))
        frame_index = int(row["frame_index"])
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            continue

        gray, _processed = preprocess_for_ocr(frame)
        quality = quality_metrics(gray, str(row["quality_label"]), "video-frame")
        change_score = 0.0
        if previous_gray is not None:
            change_score = histogram_change_score(previous_gray, gray)
        previous_gray = gray

        rows.append({
            "video_filename": row["video_filename"],
            "frame_index": frame_index,
            "timestamp_sec": row["timestamp_sec"],
            "screen_id": row["screen_id"],
            "has_popup": row["has_popup"],
            "quality_label": row["quality_label"],
            "expected_change": row["expected_change"],
            "quality_pass": quality["is_usable"],
            "change_score": change_score,
            "change_detected": change_score > 0.08,
        })

    write_csv_dicts(ABLATION_DIR / "real-video-frame-results.csv", rows, [
        "video_filename", "frame_index", "timestamp_sec", "screen_id", "has_popup",
        "quality_label", "expected_change", "quality_pass", "change_score", "change_detected",
    ])
    if rows:
        print(f"Evaluated {len(rows)} labeled video frames.")


def histogram_change_score(prev_gray: np.ndarray, gray: np.ndarray) -> float:
    hist_a = cv2.calcHist([prev_gray], [0], None, [64], [0, 256])
    hist_b = cv2.calcHist([gray], [0], None, [64], [0, 256])
    cv2.normalize(hist_a, hist_a)
    cv2.normalize(hist_b, hist_b)
    corr = cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL)
    return float(1.0 - corr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate real-capture BIOS OpenCV dataset.")
    parser.add_argument(
        "--image-dir",
        type=Path,
        default=None,
        help="Optional external folder containing real-capture BIOS images.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    image_dir = args.image_dir
    if image_dir is None and DEFAULT_EXTERNAL_IMAGE_DIR.exists():
        image_dir = DEFAULT_EXTERNAL_IMAGE_DIR
    evaluate_bios_images(image_dir)
    evaluate_video_frames()


if __name__ == "__main__":
    main()
