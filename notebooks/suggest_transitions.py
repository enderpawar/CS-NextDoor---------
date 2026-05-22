"""
영상에서 전환 후보 timestamp 자동 검출.

단순 픽셀 BGR diff (히스토그램 메트릭과 무관) → 평가 메트릭 순환 아님.
peak finder로 변화 큰 시점 top-K 추출 → 사용자가 확인 후 ground-truth.csv 라벨링.

사용:
  python notebooks/suggest_transitions.py <video_path> [--top 10]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def suggest(video_path: Path, top_k: int = 12, min_gap_sec: float = 1.5, sample_fps: float = 10.0) -> list[tuple[float, float]]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f'cannot open {video_path}')
    native_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(native_fps / sample_fps)))
    diffs: list[tuple[float, float]] = []  # (timestamp, mean_abs_diff)
    prev_small: np.ndarray | None = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            ts = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            # 160x90으로 축소 — 손떨림/노이즈 영향 줄이고 의미있는 큰 변화만 잡음
            small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
            small_f = small.astype(np.float32)
            if prev_small is not None:
                d = float(np.mean(np.abs(small_f - prev_small)))
                diffs.append((ts, d))
            prev_small = small_f
        idx += 1
    cap.release()

    if not diffs:
        return []

    # min_gap_sec 이내의 이웃 피크는 한 개만 (Non-maximum suppression)
    sorted_diffs = sorted(diffs, key=lambda x: x[1], reverse=True)
    picked: list[tuple[float, float]] = []
    for ts, d in sorted_diffs:
        if all(abs(ts - pt) >= min_gap_sec for pt, _ in picked):
            picked.append((ts, d))
        if len(picked) >= top_k:
            break
    picked.sort(key=lambda x: x[0])
    return picked


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('video', type=Path)
    ap.add_argument('--top', type=int, default=12)
    ap.add_argument('--min-gap', type=float, default=1.5, help='minimum seconds between candidate peaks')
    args = ap.parse_args()

    suggestions = suggest(args.video, top_k=args.top, min_gap_sec=args.min_gap)
    print(f'\n자동 검출 후보 ({len(suggestions)}개) — 픽셀 BGR diff peak:\n')
    print(f'  {"#":>3} {"timestamp":>10}   diff(0~255)')
    for i, (ts, d) in enumerate(suggestions, 1):
        bar = '█' * int(min(40, d * 1.5))
        print(f'  {i:>3} {ts:>9.2f}s   {d:6.2f}  {bar}')
    print('\n→ 위 timestamp들이 실제 화면 전환과 일치하는지 확인 후 ground-truth.csv에 추가.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
