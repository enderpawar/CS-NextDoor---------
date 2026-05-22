"""
영상의 지정 timestamp들에서 프레임을 추출해 한 장의 contact sheet로 저장.

사용:
  python notebooks/contact_sheet.py <video> --timestamps 0.7,4.3,8.1,... --out docs/cv-pipeline/real-video-candidates.png
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import cv2
import numpy as np


def grab_frame(cap: cv2.VideoCapture, t_sec: float) -> np.ndarray | None:
    cap.set(cv2.CAP_PROP_POS_MSEC, t_sec * 1000.0)
    ok, frame = cap.read()
    return frame if ok else None


def make_sheet(video: Path, timestamps: list[float], out: Path, cols: int = 5, cell_w: int = 480) -> None:
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f'cannot open {video}')
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cell_h = max(1, round(cell_w * src_h / src_w))
    rows = math.ceil(len(timestamps) / cols)
    sheet = np.full((rows * (cell_h + 36) + 8, cols * cell_w + 8, 3), 32, dtype=np.uint8)
    for i, ts in enumerate(timestamps):
        r, c = divmod(i, cols)
        frame = grab_frame(cap, ts)
        if frame is None:
            continue
        small = cv2.resize(frame, (cell_w, cell_h), interpolation=cv2.INTER_AREA)
        y0 = r * (cell_h + 36) + 4
        x0 = c * cell_w + 4
        sheet[y0:y0 + cell_h, x0:x0 + cell_w] = small
        label = f'#{i+1}  t={ts:.2f}s'
        cv2.putText(sheet, label, (x0 + 8, y0 + cell_h + 26),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (230, 230, 230), 2)
    cap.release()
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), sheet)
    print(f'wrote {out}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('video', type=Path)
    ap.add_argument('--timestamps', required=True, help='comma-separated seconds')
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--cols', type=int, default=5)
    ap.add_argument('--cell-w', type=int, default=480)
    args = ap.parse_args()

    ts_list = [float(x.strip()) for x in args.timestamps.split(',') if x.strip()]
    make_sheet(args.video, ts_list, args.out, cols=args.cols, cell_w=args.cell_w)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
