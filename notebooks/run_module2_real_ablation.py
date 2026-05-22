"""
모듈 2 — 실측 BIOS 영상 기반 히스토그램 변화 감지 ablation.

출력:
  docs/ablation-results/histogram-real-ablation.csv        — 조합별 raw 결과
  docs/ablation-results/histogram-real-heatmap.png         — 4메트릭×3컬러×3윈도우 F1 히트맵
  docs/ablation-results/histogram-real-roc.png             — 베스트 조합 시나리오별 ROC
  docs/ablation-results/histogram-real-summary.csv         — 조합별 평균 + 추천 BEST_PARAMS

전제:
  data/live-frames/real-*/*.mp4                            — 실측 영상
  data/live-frames/real/ground-truth.csv (또는 real-*/ground-truth.csv) — 전환 timestamp 라벨

사용:
  cd notebooks
  python run_module2_real_ablation.py
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import cv2
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from sklearn.metrics import auc, precision_recall_fscore_support, roc_curve

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / 'data'
DOCS_DIR = ROOT / 'docs'
ABLATION_DIR = DOCS_DIR / 'ablation-results'
ABLATION_DIR.mkdir(parents=True, exist_ok=True)
LIVE_DIR = DATA_DIR / 'live-frames'

METRICS = ['HISTCMP_CORREL', 'HISTCMP_CHISQR', 'HISTCMP_BHATTACHARYYA', 'HISTCMP_INTERSECT']
COLOR_SPACES = ['GRAY', 'HSV', 'RGB']
WINDOWS = [1, 3, 5]
METRIC_TO_CV = {
    'HISTCMP_CORREL':        cv2.HISTCMP_CORREL,
    'HISTCMP_CHISQR':        cv2.HISTCMP_CHISQR,
    'HISTCMP_BHATTACHARYYA': cv2.HISTCMP_BHATTACHARYYA,
    'HISTCMP_INTERSECT':     cv2.HISTCMP_INTERSECT,
}

try:
    plt.rcParams['font.family'] = 'Malgun Gothic'
    plt.rcParams['axes.unicode_minus'] = False
    sns.set_theme(style='whitegrid', font='Malgun Gothic')
except Exception:
    sns.set_theme(style='whitegrid')


# ── Label loading ─────────────────────────────────────────────────────────────

def load_real_labels() -> pd.DataFrame:
    """`real/ground-truth.csv` + 각 `real-*/ground-truth.csv` 모두 합쳐 로드."""
    frames = []
    for csv_path in LIVE_DIR.glob('real*/ground-truth.csv'):
        df = pd.read_csv(csv_path)
        # scenario 컬럼이 비어있으면 video_filename 첫 디렉토리로 채움
        if 'scenario' not in df.columns or df['scenario'].isna().all():
            df['scenario'] = df['video_filename'].apply(
                lambda x: Path(str(x)).parts[0] if '/' in str(x).replace('\\', '/') else csv_path.parent.name
            )
        frames.append(df)
    if not frames:
        return pd.DataFrame(columns=['video_filename', 'event_timestamp_sec', 'event_type', 'notes', 'scenario'])
    labels = pd.concat(frames, ignore_index=True).drop_duplicates()
    labels['event_timestamp_sec'] = pd.to_numeric(labels['event_timestamp_sec'], errors='coerce')
    return labels


def find_real_videos() -> list[Path]:
    """`data/live-frames/real-*/**.mp4`만 골라서 반환. 합성과 분리."""
    return sorted(
        p for ext in ('*.mp4', '*.mov', '*.avi', '*.mkv', '*.MP4', '*.MOV')
        for p in LIVE_DIR.glob(f'real-*/{ext}')
    )


# ── Frame extraction & scoring ────────────────────────────────────────────────

def extract_frames(video_path: Path, fps: float = 10) -> list[tuple[float, np.ndarray]]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f'cannot open {video_path}')
    native_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(native_fps / fps)))
    out, idx = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            ts = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            out.append((ts, frame))
        idx += 1
    cap.release()
    return out


def video_events(video_path: Path, labels: pd.DataFrame) -> np.ndarray:
    name = video_path.name
    rel = str(video_path.relative_to(LIVE_DIR)).replace('\\', '/')
    hits = labels[(labels['video_filename'] == name) |
                  (labels['video_filename'].astype(str).str.replace('\\', '/', regex=False) == rel)]
    return hits['event_timestamp_sec'].dropna().to_numpy(dtype=float)


def labels_for_timestamps(timestamps: np.ndarray, events: np.ndarray, tol: float = 0.5) -> np.ndarray:
    if len(events) == 0:
        return np.zeros(len(timestamps), dtype=int)
    return np.array([int(np.min(np.abs(events - t)) <= tol) for t in timestamps], dtype=int)


def calc_hist(frame: np.ndarray, color_space: str) -> np.ndarray:
    if color_space == 'GRAY':
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
    elif color_space == 'HSV':
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0], None, [180], [0, 180])
    elif color_space == 'RGB':
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        parts = [cv2.calcHist([rgb], [ch], None, [64], [0, 256]) for ch in range(3)]
        hist = np.concatenate(parts, axis=0)
    else:
        raise ValueError(color_space)
    return cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)


def similarity_scores(frames: list[tuple[float, np.ndarray]], metric: str, color_space: str) -> np.ndarray:
    hists = [calc_hist(f, color_space) for _, f in frames]
    scores = [np.nan]
    for a, b in zip(hists[:-1], hists[1:]):
        scores.append(float(cv2.compareHist(a, b, METRIC_TO_CV[metric])))
    return np.array(scores, dtype=float)


def change_strength(scores: np.ndarray, metric: str) -> np.ndarray:
    """변화 강도로 정규화: 모든 메트릭이 '큰 값 = 변화 큼' 형태."""
    if metric in ('HISTCMP_CORREL', 'HISTCMP_INTERSECT'):
        return 1 - np.nan_to_num(scores, nan=1.0)
    return np.nan_to_num(scores, nan=0.0)


def stabilize(pred: np.ndarray, window: int) -> np.ndarray:
    if window <= 1:
        return pred.astype(int)
    out = np.zeros_like(pred, dtype=int)
    run = 0
    for i, val in enumerate(pred):
        run = run + 1 if val else 0
        out[i] = int(run >= window)
    return out


def evaluate_scores(y_true: np.ndarray, strength: np.ndarray, window: int, threshold: float) -> dict:
    pred = stabilize(strength >= threshold, window)
    p, r, f1, _ = precision_recall_fscore_support(y_true, pred, average='binary', zero_division=0)
    return {
        'precision': p, 'recall': r, 'f1': f1,
        'tp': int(((pred == 1) & (y_true == 1)).sum()),
        'fp': int(((pred == 1) & (y_true == 0)).sum()),
        'fn': int(((pred == 0) & (y_true == 1)).sum()),
        'tn': int(((pred == 0) & (y_true == 0)).sum()),
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    labels = load_real_labels()
    videos = find_real_videos()

    print(f'Real videos found:  {len(videos)}')
    print(f'Real labels rows:   {len(labels)}')
    if len(videos) == 0 or labels.empty:
        print('\n[!] No real videos or labels found.')
        print('    Save .mp4 files to  data/live-frames/real-<vendor>/')
        print('    Fill timestamps in  data/live-frames/real/ground-truth.csv')
        print('    See CAPTURE_GUIDE.md for details.')
        return 1

    records = []
    roc_records = []

    for video in videos:
        scenario = video.parent.name
        events = video_events(video, labels)
        if len(events) == 0:
            print(f'  [skip] {video.relative_to(LIVE_DIR)} — no labels')
            continue
        try:
            frames = extract_frames(video, fps=10)
        except Exception as e:
            print(f'  [skip] {video.relative_to(LIVE_DIR)} — {e}')
            continue
        if len(frames) < 2:
            continue
        timestamps = np.array([t for t, _ in frames])
        y_true = labels_for_timestamps(timestamps, events)
        print(f'  [ok]   {video.relative_to(LIVE_DIR)} — {len(frames)} frames, {int(y_true.sum())} positives / {len(y_true)}')

        for metric, color_space in itertools.product(METRICS, COLOR_SPACES):
            scores = similarity_scores(frames, metric, color_space)
            strength = change_strength(scores, metric)
            finite = np.isfinite(strength)
            if finite.sum() < 2 or len(np.unique(y_true[finite])) < 2:
                thresholds = np.linspace(np.nanmin(strength), np.nanmax(strength), 25) if finite.any() else [0.0]
            else:
                fpr, tpr, thr = roc_curve(y_true[finite], strength[finite])
                roc_records.append({
                    'scenario': scenario, 'metric': metric, 'color_space': color_space,
                    'fpr': fpr.tolist(), 'tpr': tpr.tolist(), 'auc': float(auc(fpr, tpr)),
                })
                thresholds = thr[np.isfinite(thr)]
            if len(thresholds) == 0:
                thresholds = [0.0]
            for window in WINDOWS:
                evals = [{**evaluate_scores(y_true, strength, window, float(t)), 'threshold': float(t)}
                         for t in thresholds]
                best = max(evals, key=lambda x: x['f1'])
                records.append({
                    'video': str(video.relative_to(LIVE_DIR)).replace('\\', '/'),
                    'scenario': scenario,
                    'metric': metric, 'color_space': color_space, 'window': window,
                    **best,
                })

    if not records:
        print('\n[!] No usable (video, label) pairs.')
        return 1

    results = pd.DataFrame(records)
    results.to_csv(ABLATION_DIR / 'histogram-real-ablation.csv', index=False)
    print(f'\nWrote {ABLATION_DIR / "histogram-real-ablation.csv"}')

    # ── Summary: 영상별 best F1 → 조합 단위 평균 ──────────────────────────────
    summary = (
        results.groupby(['metric', 'color_space', 'window'], dropna=False)
        .agg(precision=('precision', 'mean'),
             recall=('recall', 'mean'),
             f1=('f1', 'mean'),
             threshold=('threshold', 'median'))
        .reset_index()
        .sort_values('f1', ascending=False)
    )
    summary.to_csv(ABLATION_DIR / 'histogram-real-summary.csv', index=False)
    print(summary.head(10).to_string(index=False))

    # ── Heatmap ───────────────────────────────────────────────────────────────
    heat = summary.pivot_table(index='metric', columns=['color_space', 'window'], values='f1')
    fig, ax = plt.subplots(figsize=(12, 5))
    sns.heatmap(heat, annot=True, fmt='.2f', cmap='mako', ax=ax)
    ax.set_title('Histogram change detection F1 (real captures)')
    fig.tight_layout()
    fig.savefig(ABLATION_DIR / 'histogram-real-heatmap.png', dpi=180)
    plt.close(fig)
    print(f'Wrote {ABLATION_DIR / "histogram-real-heatmap.png"}')

    # ── ROC of best combo ─────────────────────────────────────────────────────
    if roc_records:
        best = summary.iloc[0]
        fig, ax = plt.subplots(figsize=(7, 6))
        for rec in roc_records:
            if rec['metric'] == best['metric'] and rec['color_space'] == best['color_space']:
                ax.plot(rec['fpr'], rec['tpr'], label=f"{rec['scenario']} AUC={rec['auc']:.2f}")
        ax.plot([0, 1], [0, 1], '--', color='gray')
        ax.set_xlabel('False Positive Rate')
        ax.set_ylabel('True Positive Rate')
        ax.set_title(f"ROC — {best['metric']} × {best['color_space']} (real)")
        ax.legend()
        fig.tight_layout()
        fig.savefig(ABLATION_DIR / 'histogram-real-roc.png', dpi=180)
        plt.close(fig)
        print(f'Wrote {ABLATION_DIR / "histogram-real-roc.png"}')

    # ── Recommended BEST_PARAMS for src/lib/cv/changeDetection.ts ─────────────
    best = summary.iloc[0]
    strength_threshold = float(best['threshold'])
    # changeDetection.ts uses similarity-domain threshold for CORREL/INTERSECT.
    if best['metric'] in ('HISTCMP_CORREL', 'HISTCMP_INTERSECT'):
        ts_threshold = 1 - strength_threshold
    else:
        ts_threshold = strength_threshold
    recommendation = {
        'metric':     str(best['metric']),
        'colorSpace': str(best['color_space']),
        'windowSize': int(best['window']),
        'threshold':  round(ts_threshold, 4),
        'mean_f1':    round(float(best['f1']), 4),
        'mean_precision': round(float(best['precision']), 4),
        'mean_recall':    round(float(best['recall']), 4),
    }
    print('\n=== Recommended BEST_PARAMS (paste into src/lib/cv/changeDetection.ts) ===')
    print(json.dumps(recommendation, indent=2, ensure_ascii=False))
    (ABLATION_DIR / 'histogram-real-best-params.json').write_text(
        json.dumps(recommendation, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'\nWrote {ABLATION_DIR / "histogram-real-best-params.json"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
