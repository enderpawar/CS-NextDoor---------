"""Fast CLAHE grid search on real-capture BIOS images.

Pre-rectifies each image once, then varies CLAHE (clip, grid) and
Adaptive Threshold (block, C). Counts text-shaped connected components
as a proxy for OCR readiness.

Reads:  C:\\Users\\user\\Desktop\\test data\\*.jpg
Writes: docs/ablation-results/bios-clahe-gridsearch.csv
        docs/ablation-results/bios-clahe-gridsearch.png
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
ABLATION_DIR = ROOT / "docs" / "ablation-results"

plt.rcParams["font.family"] = "Malgun Gothic"
plt.rcParams["axes.unicode_minus"] = False


def detect_quad(gray):
    edges = cv2.Canny(gray, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape[:2]
    image_area = h * w
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(c)
        if area < image_area * 0.08:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            return approx.reshape(4, 2).astype(np.float32)
    # Fallback bbox
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    e2 = cv2.Canny(blurred, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 17))
    closed = cv2.morphologyEx(e2, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours2, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours2:
        x, y, bw, bh = cv2.boundingRect(c)
        ar_ratio = (bw * bh) / image_area
        aspect = bw / max(1, bh)
        if 0.12 <= ar_ratio <= 0.95 and 1.2 <= aspect <= 5.8:
            boxes.append((ar_ratio, x, y, bw, bh))
    if not boxes:
        return None
    _, x, y, bw, bh = max(boxes, key=lambda r: r[0])
    return np.float32([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]])


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


def rectify(gray):
    quad = detect_quad(gray)
    if quad is None:
        return gray
    h, w = gray.shape[:2]
    dst = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    M = cv2.getPerspectiveTransform(order_quad(quad), dst)
    return cv2.warpPerspective(gray, M, (w, h))


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


def load_rectified(max_width=1280):
    paths = sorted(list(TEST_DIR.glob("*.jpg")) + list(TEST_DIR.glob("*.png")))
    rectified = []
    for path in paths:
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is None:
            continue
        if img.shape[1] > max_width:
            scale = max_width / img.shape[1]
            img = cv2.resize(img, (max_width, int(img.shape[0] * scale)),
                             interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        rectified.append((path.name, rectify(gray)))
    return rectified


def main():
    rectified = load_rectified()
    print(f"Pre-rectified {len(rectified)} images", flush=True)

    clips = [1.0, 2.0, 4.0, 8.0]
    grids = [4, 8, 16]
    blocks = [9, 11, 15, 21]
    Cs = [0, 2, 4]

    rows = []
    total = len(clips) * len(grids) * len(blocks) * len(Cs)
    done = 0
    for clip in clips:
        for grid in grids:
            # Pre-compute CLAHE once per (clip, grid)
            clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=(grid, grid))
            enhanced_cache = [clahe.apply(g) for _, g in rectified]
            for block in blocks:
                blk = int(block) if int(block) % 2 == 1 else int(block) + 1
                for C in Cs:
                    rois = []
                    for enh in enhanced_cache:
                        binary = cv2.adaptiveThreshold(
                            enh, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                            cv2.THRESH_BINARY, blk, int(C))
                        rois.append(count_text_rois(binary))
                    rows.append({
                        "clip": clip, "grid": grid, "block": block, "C": C,
                        "n": len(rois),
                        "mean_text_roi": float(np.mean(rois)),
                    })
                    done += 1
                    if done % 12 == 0:
                        print(f"  progress: {done}/{total}", flush=True)

    csv_path = ABLATION_DIR / "bios-clahe-gridsearch.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["clip", "grid", "block", "C", "n",
                                                 "mean_text_roi"])
        writer.writeheader()
        for r in rows:
            writer.writerow(r)
    print(f"Wrote {csv_path}", flush=True)

    # Heatmap of best score per (clip, grid)
    pairs = {(r["clip"], r["grid"]): [] for r in rows}
    for r in rows:
        pairs[(r["clip"], r["grid"])].append(r["mean_text_roi"])
    mat = np.zeros((len(clips), len(grids)))
    for i, c in enumerate(clips):
        for j, g in enumerate(grids):
            mat[i, j] = max(pairs[(c, g)]) if pairs[(c, g)] else 0.0

    fig, ax = plt.subplots(figsize=(8.4, 5.4))
    im = ax.imshow(mat, cmap="viridis", aspect="auto")
    ax.set_xticks(range(len(grids)))
    ax.set_xticklabels([str(g) for g in grids])
    ax.set_yticks(range(len(clips)))
    ax.set_yticklabels([str(c) for c in clips])
    ax.set_xlabel("CLAHE tileGridSize", fontsize=11)
    ax.set_ylabel("CLAHE clipLimit", fontsize=11)
    ax.set_title("CLAHE grid search — max mean text-ROI count "
                 "(22 real-capture frames, block & C swept)", fontsize=12)
    for i in range(len(clips)):
        for j in range(len(grids)):
            ax.text(j, i, f"{mat[i, j]:.0f}", ha="center", va="center",
                    color="white" if mat[i, j] < mat.max() * 0.55 else "black",
                    fontsize=11, weight="bold")
    fig.colorbar(im, ax=ax, label="mean text ROIs")
    fig.tight_layout()
    fig.savefig(ABLATION_DIR / "bios-clahe-gridsearch.png", dpi=160,
                bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("Wrote bios-clahe-gridsearch.png", flush=True)

    best = max(rows, key=lambda r: r["mean_text_roi"])
    print(f"Best params: clip={best['clip']}, grid={best['grid']}, "
          f"block={best['block']}, C={best['C']}, "
          f"mean_text_roi={best['mean_text_roi']:.1f}", flush=True)


if __name__ == "__main__":
    main()
