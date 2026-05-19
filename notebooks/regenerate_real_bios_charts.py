"""Regenerate placeholder BIOS charts using real-capture data.

Source images: C:\\Users\\user\\Desktop\\test data (22 real BIOS photos).

Replaces these previously-synthetic outputs with real-data versions:
  - docs/cv-pipeline/bios-pipeline-stages.png       (stages on a real frame)
  - docs/cv-pipeline/bios-threshold-comparison.png  (Otsu/Mean/Gaussian on a real frame)
  - docs/ablation-results/bios-ablation.png         (proxy metrics, OCR-free)
  - docs/ablation-results/bios-ablation.csv         (proxy ablation table)
  - docs/ablation-results/bios-clahe-gridsearch.png (proxy metric grid)
  - docs/ablation-results/bios-clahe-gridsearch.csv

Because pytesseract is unavailable in this environment, OCR-similarity numbers
cannot be computed against ground truth. Instead we use three proxy metrics
that quantify how OCR-ready the preprocessing makes the frame:
  - text_roi_count   : number of text-shaped connected components (higher = better)
  - local_contrast   : std of the preprocessed image (higher = better separation)
  - laplacian_var    : Laplacian variance of preprocessed image (higher = sharper)

All metrics are averaged over the 22 real-capture BIOS images.
"""

from __future__ import annotations

import csv
import itertools
from pathlib import Path

import cv2
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TEST_DIR = Path(r"C:\Users\user\Desktop\test data")
PIPELINE_DIR = ROOT / "docs" / "cv-pipeline"
ABLATION_DIR = ROOT / "docs" / "ablation-results"
PIPELINE_DIR.mkdir(parents=True, exist_ok=True)
ABLATION_DIR.mkdir(parents=True, exist_ok=True)

plt.rcParams["font.family"] = "Malgun Gothic"
plt.rcParams["axes.unicode_minus"] = False


def load_real_images(max_width: int = 1280):
    paths = sorted(list(TEST_DIR.glob("*.jpg")) + list(TEST_DIR.glob("*.png")))
    images = []
    for path in paths:
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is None:
            continue
        if img.shape[1] > max_width:
            scale = max_width / img.shape[1]
            img = cv2.resize(img, (max_width, int(img.shape[0] * scale)),
                             interpolation=cv2.INTER_AREA)
        images.append((path, img))
    return images


def detect_screen_quad(gray):
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 80, minLineLength=80, maxLineGap=12)
    if lines is None:
        return None
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape[:2]
    image_area = h * w
    candidates = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < image_area * 0.08:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            candidates.append((area, approx.reshape(4, 2)))
    if not candidates:
        # Fallback: largest bounding box from morph-closed edges
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        e2 = cv2.Canny(blurred, 40, 120)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 17))
        closed = cv2.morphologyEx(e2, cv2.MORPH_CLOSE, kernel, iterations=2)
        c2, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not c2:
            return None
        boxes = []
        for c in c2:
            x, y, bw, bh = cv2.boundingRect(c)
            ar_ratio = (bw * bh) / image_area
            aspect = bw / max(1, bh)
            if 0.12 <= ar_ratio <= 0.95 and 1.2 <= aspect <= 5.8:
                boxes.append((ar_ratio, x, y, bw, bh))
        if not boxes:
            return None
        _, x, y, bw, bh = max(boxes, key=lambda r: r[0])
        return np.float32([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]])
    _, corners = max(candidates, key=lambda item: item[0])
    return corners.astype(np.float32)


def order_quad(quad):
    pts = quad.reshape(4, 2)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    return np.float32([
        pts[np.argmin(s)],
        pts[np.argmin(diff)],
        pts[np.argmax(s)],
        pts[np.argmax(diff)],
    ])


def rectify(gray, enabled=True):
    if not enabled:
        return gray
    quad = detect_screen_quad(gray)
    if quad is None:
        return gray
    h, w = gray.shape[:2]
    ordered = order_quad(quad)
    dst = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    M = cv2.getPerspectiveTransform(ordered, dst)
    return cv2.warpPerspective(gray, M, (w, h))


def apply_clahe(gray, enabled=True, clip=2.0, grid=8):
    if not enabled:
        return gray
    clahe = cv2.createCLAHE(clipLimit=float(clip), tileGridSize=(int(grid), int(grid)))
    return clahe.apply(gray)


def binarize(gray, enabled=True, block=11, C=2, method="gaussian"):
    if not enabled:
        return gray
    block = int(block) if int(block) % 2 == 1 else int(block) + 1
    adaptive = (cv2.ADAPTIVE_THRESH_GAUSSIAN_C if method == "gaussian"
                else cv2.ADAPTIVE_THRESH_MEAN_C)
    return cv2.adaptiveThreshold(gray, 255, adaptive, cv2.THRESH_BINARY, block, int(C))


def filter_components(binary, enabled=True, min_area=50):
    if not enabled:
        return binary
    if binary.dtype != np.uint8:
        binary = binary.astype(np.uint8)
    # work on inverted (text=foreground) for connectedComponents
    inv = 255 - binary
    num, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    keep = np.zeros(binary.shape, dtype=np.uint8)
    for idx in range(1, num):
        if stats[idx, cv2.CC_STAT_AREA] >= min_area:
            keep[labels == idx] = 255
    return 255 - keep


def count_text_rois(binary):
    inv = 255 - binary
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 2))
    merged = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, kernel, iterations=1)
    num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(merged, 8)
    h, w = binary.shape[:2]
    image_area = h * w
    min_h = max(10, int(h * 0.006))
    max_h = max(42, int(h * 0.07))
    min_w = max(12, int(w * 0.004))
    max_w = max(220, int(w * 0.28))
    count = 0
    for label in range(1, num_labels):
        x, y, bw, bh, area = stats[label]
        if area < 120 or area > image_area * 0.02:
            continue
        aspect = bw / max(1, bh)
        fill_ratio = area / max(1, bw * bh)
        if (min_w <= bw <= max_w and min_h <= bh <= max_h
                and 0.25 <= aspect <= 18 and 0.05 <= fill_ratio <= 0.85):
            count += 1
    return count


def run_pipeline(color_img, homography=True, clahe=True, threshold=True, components=True,
                 clip=2.0, grid=8, block=11, C=2):
    gray = cv2.cvtColor(color_img, cv2.COLOR_BGR2GRAY)
    rectified = rectify(gray, homography)
    enhanced = apply_clahe(rectified, clahe, clip=clip, grid=grid)
    if threshold:
        binary = binarize(enhanced, True, block=block, C=C)
        cc = filter_components(binary, components)
    else:
        binary = enhanced
        cc = enhanced
    return {
        "gray": gray,
        "rectified": rectified,
        "enhanced": enhanced,
        "binary": binary,
        "components": cc,
    }


def proxy_metrics(result, threshold_on):
    target = result["components"] if threshold_on else result["enhanced"]
    if threshold_on:
        rois = count_text_rois(result["binary"])
    else:
        # When threshold is off the image isn't binary; approximate by adaptive threshold once
        tmp = binarize(target, True, block=11, C=2)
        rois = count_text_rois(tmp)
    lap_var = float(cv2.Laplacian(result["enhanced"], cv2.CV_64F).var())
    local_contrast = float(result["enhanced"].std())
    return {
        "text_roi_count": rois,
        "laplacian_var": lap_var,
        "local_contrast": local_contrast,
    }


# ---------------------------------------------------------------------------
# 1) Pipeline stages + threshold comparison galleries on a real frame
# ---------------------------------------------------------------------------
def save_pipeline_stages(images):
    # Pick a frame that has reasonable sharpness so each stage is visible.
    best = None
    best_score = -1
    for path, img in images:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        s = cv2.Laplacian(gray, cv2.CV_64F).var()
        if s > best_score:
            best_score = s
            best = (path, img)
    path, img = best
    print(f"Pipeline stages source: {path.name} (Laplacian var={best_score:.1f})")
    out = run_pipeline(img)

    fig, axes = plt.subplots(1, 5, figsize=(20, 4.2))
    stages = [
        ("Original (real capture)", cv2.cvtColor(img, cv2.COLOR_BGR2RGB)),
        ("Gray", out["gray"]),
        ("Homography/Rectified", out["rectified"]),
        ("CLAHE", out["enhanced"]),
        ("Adaptive Threshold + CC", out["components"]),
    ]
    for ax, (title, im) in zip(axes, stages):
        ax.imshow(im, cmap="gray" if im.ndim == 2 else None)
        ax.set_title(title, fontsize=11)
        ax.axis("off")
    fig.suptitle(f"BIOS pipeline stages — real capture ({path.name})",
                 fontsize=13, y=1.02)
    fig.tight_layout()
    fig.savefig(PIPELINE_DIR / "bios-pipeline-stages.png", dpi=160,
                bbox_inches="tight", facecolor="white")
    plt.close(fig)

    # Threshold comparison
    enh = out["enhanced"]
    otsu = cv2.threshold(enh, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    mean_t = binarize(enh, True, method="mean")
    gauss = binarize(enh, True, method="gaussian")

    # Count text ROIs each method exposes
    rois = {"Otsu": count_text_rois(otsu),
            "Adaptive Mean": count_text_rois(mean_t),
            "Adaptive Gaussian": count_text_rois(gauss)}

    fig, axes = plt.subplots(1, 3, figsize=(14, 4.6))
    for ax, (title, bm) in zip(axes,
                                [("Otsu", otsu),
                                 ("Adaptive Mean", mean_t),
                                 ("Adaptive Gaussian", gauss)]):
        ax.imshow(bm, cmap="gray")
        ax.set_title(f"{title}\ntext ROIs detected: {rois[title]}", fontsize=11)
        ax.axis("off")
    fig.suptitle(f"Threshold methods — real capture ({path.name})",
                 fontsize=13, y=1.02)
    fig.tight_layout()
    fig.savefig(PIPELINE_DIR / "bios-threshold-comparison.png", dpi=160,
                bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return rois


# ---------------------------------------------------------------------------
# 2) Ablation table (proxy metrics over all 22 real images)
# ---------------------------------------------------------------------------
def run_ablation(images):
    rows = []
    flags = ["homography", "clahe", "threshold", "components"]
    for combo in itertools.product([False, True], repeat=4):
        params = dict(zip(flags, combo))
        rois, laps, contrasts = [], [], []
        for _, img in images:
            try:
                result = run_pipeline(img, **params)
                m = proxy_metrics(result, params["threshold"])
                rois.append(m["text_roi_count"])
                laps.append(m["laplacian_var"])
                contrasts.append(m["local_contrast"])
            except Exception as exc:  # pragma: no cover
                print("ablation failure:", exc)
        rows.append({
            **params,
            "n": len(rois),
            "mean_text_roi": float(np.mean(rois)) if rois else 0.0,
            "mean_laplacian_var": float(np.mean(laps)) if laps else 0.0,
            "mean_local_contrast": float(np.mean(contrasts)) if contrasts else 0.0,
        })

    # Save CSV
    fieldnames = ["homography", "clahe", "threshold", "components", "n",
                  "mean_text_roi", "mean_laplacian_var", "mean_local_contrast"]
    csv_path = ABLATION_DIR / "bios-ablation.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)
    # Maintain compatibility filename
    pipeline_csv = ABLATION_DIR / "bios-pipeline-ablation.csv"
    pipeline_csv.write_text(csv_path.read_text(encoding="utf-8"), encoding="utf-8")

    # Plot: text ROI count by configuration
    labels = ["".join("1" if r[k] else "0" for k in flags) for r in rows]
    rois = [r["mean_text_roi"] for r in rows]

    order = np.argsort(rois)[::-1]
    labels_sorted = [labels[i] for i in order]
    rois_sorted = [rois[i] for i in order]

    fig, ax = plt.subplots(figsize=(13, 5.2))
    colors = ["#1f77b4"] * len(rois_sorted)
    # Highlight the full-pipeline configuration
    full = "1111"
    if full in labels_sorted:
        colors[labels_sorted.index(full)] = "#d62728"
    bars = ax.bar(labels_sorted, rois_sorted, color=colors)
    ax.set_xlabel("homography / clahe / threshold / components  (0=off, 1=on)",
                  fontsize=11)
    ax.set_ylabel("Mean text-ROI count (22 real-capture images)", fontsize=11)
    ax.set_title("BIOS preprocessing ablation — text-ROI yield (OCR-ready candidates)",
                 fontsize=12)
    ax.tick_params(axis="x", rotation=45)
    for bar, val in zip(bars, rois_sorted):
        ax.text(bar.get_x() + bar.get_width() / 2, val + max(rois_sorted) * 0.01,
                f"{val:.0f}", ha="center", va="bottom", fontsize=9)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(ABLATION_DIR / "bios-ablation.png", dpi=160,
                bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return rows


# ---------------------------------------------------------------------------
# 3) CLAHE grid search (using text-ROI count as proxy)
# ---------------------------------------------------------------------------
def run_grid_search(images):
    rows = []
    for clip, grid in itertools.product([1.0, 2.0, 4.0, 8.0], [4, 8, 16]):
        for block in [9, 11, 15, 21]:
            for C in [0, 2, 4]:
                rois = []
                for _, img in images:
                    try:
                        result = run_pipeline(img, clip=clip, grid=grid,
                                              block=block, C=C)
                        rois.append(count_text_rois(result["binary"]))
                    except Exception:
                        pass
                rows.append({
                    "clip": clip, "grid": grid, "block": block, "C": C,
                    "n": len(rois),
                    "mean_text_roi": float(np.mean(rois)) if rois else 0.0,
                })

    csv_path = ABLATION_DIR / "bios-clahe-gridsearch.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["clip", "grid", "block", "C", "n",
                                                 "mean_text_roi"])
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

    # Heatmap of best score per (clip, grid)
    pairs = {(r["clip"], r["grid"]): [] for r in rows}
    for r in rows:
        pairs[(r["clip"], r["grid"])].append(r["mean_text_roi"])
    clips = sorted({r["clip"] for r in rows})
    grids = sorted({r["grid"] for r in rows})
    mat = np.zeros((len(clips), len(grids)))
    for i, c in enumerate(clips):
        for j, g in enumerate(grids):
            mat[i, j] = max(pairs[(c, g)]) if pairs[(c, g)] else 0.0

    fig, ax = plt.subplots(figsize=(8, 5.4))
    im = ax.imshow(mat, cmap="viridis", aspect="auto")
    ax.set_xticks(range(len(grids)))
    ax.set_xticklabels([str(g) for g in grids])
    ax.set_yticks(range(len(clips)))
    ax.set_yticklabels([str(c) for c in clips])
    ax.set_xlabel("CLAHE tileGridSize", fontsize=11)
    ax.set_ylabel("CLAHE clipLimit", fontsize=11)
    ax.set_title("CLAHE grid search — best mean text-ROI count (22 real frames)",
                 fontsize=12)
    for i in range(len(clips)):
        for j in range(len(grids)):
            ax.text(j, i, f"{mat[i, j]:.0f}", ha="center", va="center",
                    color="white" if mat[i, j] < mat.max() * 0.6 else "black",
                    fontsize=10)
    fig.colorbar(im, ax=ax, label="mean text ROIs")
    fig.tight_layout()
    fig.savefig(ABLATION_DIR / "bios-clahe-gridsearch.png", dpi=160,
                bbox_inches="tight", facecolor="white")
    plt.close(fig)

    best = max(rows, key=lambda r: r["mean_text_roi"])
    print(f"Best CLAHE params: clip={best['clip']}, grid={best['grid']}, "
          f"block={best['block']}, C={best['C']}, "
          f"mean_text_roi={best['mean_text_roi']:.1f}")
    return rows, best


def main():
    images = load_real_images()
    if not images:
        raise SystemExit(f"No real-capture images in {TEST_DIR}")
    print(f"Loaded {len(images)} real BIOS captures.")

    save_pipeline_stages(images)
    print("Saved bios-pipeline-stages.png and bios-threshold-comparison.png")

    ablation = run_ablation(images)
    print(f"Saved bios-ablation.png / .csv ({len(ablation)} rows)")

    grid, best = run_grid_search(images)
    print(f"Saved bios-clahe-gridsearch.png / .csv ({len(grid)} rows)")


if __name__ == "__main__":
    main()
