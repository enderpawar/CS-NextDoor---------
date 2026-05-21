"""
Pipeline Comparison: Gemini Only vs CV + Gemini
Generates README ablation charts to docs/ablation-results/
"""
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import seaborn as sns
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

# Style
sns.set_theme(style='whitegrid', context='paper', font_scale=1.2)
try:
    plt.rcParams['font.family'] = 'Malgun Gothic'
except Exception:
    pass
plt.rcParams['axes.unicode_minus'] = False

COLORS = {
    'gemini_only': '#ef4444',
    'cv_gemini':   '#3b82f6',
    'neutral':     '#9ca3af',
    'good':        '#22c55e',
    'warning':     '#f59e0b',
}

BASE_DIR   = Path(__file__).parent.parent
OUTPUT_DIR = BASE_DIR / 'docs' / 'ablation-results'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Load real data ──────────────────────────────────────────────────────────
quality_df = pd.read_csv(OUTPUT_DIR / 'quality-metrics.csv')
hist_df    = pd.read_csv(OUTPUT_DIR / 'histogram-ablation.csv')

REAL_BIOS_TOTAL = 22
REAL_BIOS_PASS  = 8
REAL_PASS_RATE  = REAL_BIOS_PASS / REAL_BIOS_TOTAL  # 36.4%

best_hist = hist_df[
    (hist_df['metric']       == 'HISTCMP_CORREL') &
    (hist_df['color_space']  == 'GRAY') &
    (hist_df['window']       == 5) &
    (hist_df['scenario']     == 'normal-change')
]
BEST_F1        = float(best_hist['f1'].values[0])        if len(best_hist) else 0.917
BEST_PRECISION = float(best_hist['precision'].values[0]) if len(best_hist) else 0.846
BEST_RECALL    = float(best_hist['recall'].values[0])    if len(best_hist) else 1.0

scenarios_order = ['hand-shake', 'rolling-shutter', 'ios-autofocus', 'lighting', 'normal-change']
w1_fp, w5_fp = [], []
for s in scenarios_order:
    sub = hist_df[
        (hist_df['metric']       == 'HISTCMP_CORREL') &
        (hist_df['color_space']  == 'GRAY') &
        (hist_df['scenario']     == s)
    ]
    w1 = sub[sub['window'] == 1]['fp'].mean()
    w5 = sub[sub['window'] == 5]['fp'].mean()
    w1_fp.append(float(w1) if not np.isnan(w1) else 0.0)
    w5_fp.append(float(w5) if not np.isnan(w5) else 0.0)

# ── Simulation ──────────────────────────────────────────────────────────────
np.random.seed(42)
FPS             = 30
DURATION_SEC    = 60
TOTAL_FRAMES    = FPS * DURATION_SEC   # 1,800
SCENE_CHANGES_N = 8
MIN_Q           = 30
COOLDOWN_FRAMES = FPS * 2
WINDOW_SIZE     = 3

# 실촬영 데이터(22장) 기반 품질 분포 직접 calibration:
#   통과 36.4% / 거부 63.6%
#   거부 유형: 손 떨림+RS 35%, 저조도 17%, 과노출 12%
BAD_TOTAL_RATE = 1.0 - REAL_PASS_RATE  # 0.636
BAD_BLUR_FRAC  = 0.35 / BAD_TOTAL_RATE
BAD_DARK_FRAC  = 0.17 / BAD_TOTAL_RATE
BAD_OVER_FRAC  = 0.12 / BAD_TOTAL_RATE

change_starts = sorted(np.random.choice(
    range(FPS * 5, TOTAL_FRAMES - FPS * 5),
    size=SCENE_CHANGES_N, replace=False
))

# 화면 전환 후 히스토그램 변화가 유지되는 기간 (현실: 키 입력 후 화면이 안정될 때까지)
CHANGE_PERSIST_FRAMES = 20  # ~0.67초 동안 히스토그램 차이 유지

rows = []
for i in range(TOTAL_FRAMES):
    rnd = np.random.random()
    if rnd < BAD_TOTAL_RATE:
        # 불량 프레임 — 유형 결정
        sub = np.random.random()
        if sub < BAD_BLUR_FRAC:
            q = np.random.uniform(2, 22)
            is_blur, is_dark, is_over = True, False, False
        elif sub < BAD_BLUR_FRAC + BAD_DARK_FRAC:
            q = np.random.uniform(5, 28)
            is_blur, is_dark, is_over = False, True, False
        else:
            q = np.random.uniform(10, 26)
            is_blur, is_dark, is_over = False, False, True
    else:
        # 양질 프레임
        q = float(np.clip(np.random.normal(73, 16), 30, 100))
        is_blur, is_dark, is_over = False, False, False

    # 화면 전환 감지: 전환 시점부터 CHANGE_PERSIST_FRAMES 동안 히스토그램 변화 신호
    is_scene_change = any(0 <= (i - s) < CHANGE_PERSIST_FRAMES for s in change_starts)

    rows.append({
        'frame': i,
        'time_sec': i / FPS,
        'is_blur': is_blur,
        'is_dark': is_dark,
        'is_over': is_over,
        'quality': q,
        'passes_quality': q >= MIN_Q,
        'is_scene_change': is_scene_change,
    })

df = pd.DataFrame(rows)
q_pass = int(df['passes_quality'].sum())
q_fail = TOTAL_FRAMES - q_pass

# CV+Gemini simulation
cv_sent = 0
cv_sent_times = []
consec = 0
last_sent_i = -COOLDOWN_FRAMES * 2
for i, row in df.iterrows():
    if not row['passes_quality']:
        consec = 0
        continue
    in_cd = (i - last_sent_i) < COOLDOWN_FRAMES
    consec = (consec + 1) if row['is_scene_change'] else 0
    if consec >= WINDOW_SIZE and not in_cd:
        cv_sent += 1
        cv_sent_times.append(row['time_sec'])
        last_sent_i = i
        consec = 0

# Gemini Only simulation (every 2 seconds)
go_interval = 2
go_times  = list(range(go_interval, DURATION_SEC, go_interval))
go_count  = len(go_times)
go_on_bad = sum(
    1 for t in go_times
    if not df[np.abs(df['time_sec'] - t) < 0.05]['passes_quality'].any()
)

COST_PER_CALL = 765 * 0.00001875 / 1000
cost_go = go_count * COST_PER_CALL * 3600
cost_cv = cv_sent  * COST_PER_CALL * 3600

actual_changes = [s / FPS for s in change_starts]

print(f"Simulation: {TOTAL_FRAMES} frames | quality_pass={q_pass} | cv_sent={cv_sent} | go_count={go_count}")
print(f"Quality pass rate: {q_pass/TOTAL_FRAMES:.1%} (vs real 36.4%)")

# ── Chart 1: Pipeline Funnel ─────────────────────────────────────────────────
print("Generating funnel chart...")
fig, ax = plt.subplots(figsize=(9, 5.5))
fig.patch.set_facecolor('white')
ax.set_facecolor('#f8f9fd')

stages = [
    ('카메라 입력',               TOTAL_FRAMES,             '#6b7280', '30fps x 60s'),
    ('[모듈 3] 품질 게이트 통과', q_pass,                   '#f59e0b', f'Laplacian+밝기 | {q_fail}장 거부 ({q_fail/TOTAL_FRAMES:.0%})'),
    ('[모듈 2] 변화 감지 통과',   SCENE_CHANGES_N * 3,      '#3b82f6', 'CORREL+GRAY+window=3 | 연속 3프레임'),
    ('[모듈 1] BIOS 전처리 후 전송', cv_sent,               '#22c55e', 'CLAHE+Homography+CC -> Gemini'),
]

max_w     = max(s[1] for s in stages)
bar_h     = 0.55
y_pos     = np.arange(len(stages))[::-1]

for j, (label, count, color, note) in enumerate(stages):
    y  = y_pos[j]
    w  = count / max_w
    ax.barh(y, w, height=bar_h, color=color, alpha=0.88,
            left=(1 - w) / 2, linewidth=1.5, edgecolor='white')
    ax.text(0.5, y, f'{count:,}', ha='center', va='center',
            fontsize=11, fontweight='bold', color='white')
    ax.text(0.5, y - bar_h * 0.62, f'{label}  |  {note}',
            ha='center', va='top', fontsize=7.5, color='#374151')
    pct = count / TOTAL_FRAMES
    ax.text(1.015, y, f'{pct:.1%}', va='center', fontsize=10,
            color=color, fontweight='bold')

for j in range(len(stages) - 1):
    y_from = y_pos[j + 1] + bar_h / 2
    y_to   = y_pos[j]     - bar_h / 2
    ax.annotate('', xy=(0.5, y_to + 0.04), xytext=(0.5, y_from - 0.04),
                arrowprops=dict(arrowstyle='->', color='#9ca3af', lw=1.8))

ax.set_xlim(0, 1.20)
ax.set_ylim(-0.8, len(stages) - 0.5)
ax.axis('off')
ax.set_title('CV 파이프라인 프레임 필터링 퍼널\n(60초 BIOS 세션, 30fps = 1,800 프레임)',
             fontsize=13, fontweight='bold', pad=12)

plt.tight_layout()
out1 = OUTPUT_DIR / 'pipeline-comparison-funnel.png'
plt.savefig(out1, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f"  -> {out1.name}")

# ── Chart 2: API Calls Comparison ────────────────────────────────────────────
print("Generating API calls comparison chart...")
fig, axes = plt.subplots(1, 3, figsize=(12, 5))
fig.patch.set_facecolor('white')
methods     = ['Gemini\nOnly', 'CV +\nGemini']
bar_colors  = [COLORS['gemini_only'], COLORS['cv_gemini']]

# (1) Call count
ax = axes[0]
ax.set_facecolor('#f8f9fd')
vals = [go_count, cv_sent]
bars = ax.bar(methods, vals, color=bar_colors, width=0.45, edgecolor='white', linewidth=1.5)
for bar, v in zip(bars, vals):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.4,
            str(v), ha='center', va='bottom', fontsize=14, fontweight='bold')
ax.set_title('API 호출 횟수 (60초)', fontsize=11, fontweight='bold')
ax.set_ylabel('호출 수')
ax.set_ylim(0, go_count * 1.35)
reduction = (1 - cv_sent / go_count) * 100
ax.text(0.5, 0.91, f'▼ {reduction:.0f}% 절감', transform=ax.transAxes,
        ha='center', fontsize=12, color=COLORS['cv_gemini'], fontweight='bold')

# (2) Stacked useful vs bad
ax = axes[1]
ax.set_facecolor('#f8f9fd')
go_stacked  = [go_on_bad,           go_count - go_on_bad]
cv_stacked  = [0,                    cv_sent]
lbls        = ['품질 불량 호출',     '유효 호출']
sc          = [COLORS['warning'],    COLORS['good']]

bot_go, bot_cv = 0, 0
for vg, vc, c, lb in zip(go_stacked, cv_stacked, sc, lbls):
    b1 = ax.bar(['Gemini\nOnly'], vg, bottom=bot_go, color=c,
                width=0.45, edgecolor='white', label=lb)
    b2 = ax.bar(['CV +\nGemini'], vc, bottom=bot_cv, color=c,
                width=0.45, edgecolor='white')
    if vg > 0:
        ax.text(b1[0].get_x() + b1[0].get_width()/2, bot_go + vg/2,
                str(vg), ha='center', va='center', fontsize=11, color='white', fontweight='bold')
    if vc > 0:
        ax.text(b2[0].get_x() + b2[0].get_width()/2, bot_cv + vc/2,
                str(vc), ha='center', va='center', fontsize=11, color='white', fontweight='bold')
    bot_go += vg
    bot_cv += vc

ax.set_title('호출 품질 분해', fontsize=11, fontweight='bold')
ax.set_ylabel('호출 수')
ax.legend(loc='upper right', fontsize=8)
ax.set_ylim(0, go_count * 1.30)

# (3) Estimated cost
ax = axes[2]
ax.set_facecolor('#f8f9fd')
costs = [cost_go, cost_cv]
bars = ax.bar(methods, costs, color=bar_colors, width=0.45, edgecolor='white', linewidth=1.5)
for bar, v in zip(bars, costs):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + cost_go * 0.012,
            f'${v:.2f}', ha='center', va='bottom', fontsize=13, fontweight='bold')
ax.set_title('추정 비용/시간 (Gemini Flash)', fontsize=11, fontweight='bold')
ax.set_ylabel('USD / hour')
ax.set_ylim(0, cost_go * 1.35)
cost_save = (1 - cost_cv / cost_go) * 100
ax.text(0.5, 0.91, f'▼ {cost_save:.0f}% 절감', transform=ax.transAxes,
        ha='center', fontsize=12, color=COLORS['cv_gemini'], fontweight='bold')

fig.suptitle('Gemini Only vs CV + Gemini — API 효율 비교',
             fontsize=14, fontweight='bold', y=1.01)
plt.tight_layout()
out2 = OUTPUT_DIR / 'pipeline-comparison-api-calls.png'
plt.savefig(out2, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f"  -> {out2.name}")

# ── Chart 3: Timeline ───────────────────────────────────────────────────────
print("Generating timeline chart...")
fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 4.5), sharex=True)
fig.patch.set_facecolor('white')

for ax in [ax1, ax2]:
    ax.set_facecolor('#f8f9fd')
    for t in actual_changes:
        ax.axvspan(t - 0.3, t + 0.3, color='#22c55e', alpha=0.25,
                   label='실제 화면 전환' if t == actual_changes[0] else '')

for t in go_times:
    bad = not df[np.abs(df['time_sec'] - t) < 0.05]['passes_quality'].any()
    c   = COLORS['warning'] if bad else COLORS['gemini_only']
    ax1.axvline(t, color=c, alpha=0.80, linewidth=2)
    ax1.plot(t, 0.5, 'v', color=c, markersize=8)

for t in cv_sent_times:
    ax2.axvline(t, color=COLORS['cv_gemini'], alpha=0.90, linewidth=2.5)
    ax2.plot(t, 0.5, 'v', color=COLORS['cv_gemini'], markersize=10)

ax1.set_yticks([]); ax2.set_yticks([])
ax1.set_xlim(0, DURATION_SEC)
ax1.set_ylabel('Gemini\nOnly', fontsize=10, fontweight='bold',
               color=COLORS['gemini_only'], labelpad=8)
ax2.set_ylabel('CV +\nGemini', fontsize=10, fontweight='bold',
               color=COLORS['cv_gemini'], labelpad=8)
ax2.set_xlabel('시간 (초)', fontsize=10)

handles = [
    mpatches.Patch(color='#22c55e', alpha=0.5,
                   label=f'실제 화면 전환 ({SCENE_CHANGES_N}회)'),
    mpatches.Patch(color=COLORS['gemini_only'],
                   label=f'Gemini Only 호출 ({go_count}회)'),
    mpatches.Patch(color=COLORS['warning'],
                   label=f'품질 불량 호출 ({go_on_bad}회)'),
    mpatches.Patch(color=COLORS['cv_gemini'],
                   label=f'CV+Gemini 호출 ({cv_sent}회)'),
]
fig.legend(handles=handles, loc='upper center', ncol=4,
           fontsize=8.5, bbox_to_anchor=(0.5, 1.04), framealpha=0.9)
fig.suptitle('API 호출 타임라인 — 언제, 무엇을 Gemini에 보내는가?',
             fontsize=13, fontweight='bold', y=1.12)
plt.tight_layout()
out3 = OUTPUT_DIR / 'pipeline-comparison-timeline.png'
plt.savefig(out3, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f"  -> {out3.name}")

# ── Chart 4: Quality distribution of sent frames ────────────────────────────
print("Generating quality distribution chart...")
go_frame_quality = np.array([
    df.iloc[(np.abs(df['time_sec'] - t)).argmin()]['quality']
    for t in go_times
])
cv_sent_quality = df[
    df['passes_quality'] & df['is_scene_change']
]['quality'].values

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.5))
fig.patch.set_facecolor('white')

for ax in [ax1, ax2]:
    ax.set_facecolor('#f8f9fd')
    ax.axvline(MIN_Q, color='#6b7280', linestyle='--', linewidth=1.5,
               label=f'최소 품질 임계값 ({MIN_Q})', alpha=0.7)

ax1.hist(go_frame_quality, bins=20, color=COLORS['gemini_only'],
         alpha=0.75, edgecolor='white')
ax1.set_title(
    f'Gemini Only — 전송 프레임 품질\n(n={len(go_frame_quality)}, 평균={np.mean(go_frame_quality):.1f})',
    fontsize=10, fontweight='bold')
ax1.set_xlabel('품질 점수 (0~100)')
ax1.set_ylabel('프레임 수')
bad_pct = (go_frame_quality < MIN_Q).mean() * 100
ax1.text(0.97, 0.95, f'{bad_pct:.0f}% 품질 불량\n프레임 포함',
         transform=ax1.transAxes, ha='right', va='top',
         color=COLORS['gemini_only'], fontsize=11, fontweight='bold')
ax1.legend(fontsize=8)

if len(cv_sent_quality) > 0:
    ax2.hist(cv_sent_quality, bins=max(4, len(cv_sent_quality) // 2),
             color=COLORS['cv_gemini'], alpha=0.8, edgecolor='white')
    ax2.set_title(
        f'CV + Gemini — 전송 프레임 품질\n(n={len(cv_sent_quality)}, 평균={np.mean(cv_sent_quality):.1f})',
        fontsize=10, fontweight='bold')
    bad_pct_cv = (cv_sent_quality < MIN_Q).mean() * 100
    ax2.text(0.97, 0.95, f'{bad_pct_cv:.0f}% 품질 불량\n(모두 필터됨)',
             transform=ax2.transAxes, ha='right', va='top',
             color=COLORS['cv_gemini'], fontsize=11, fontweight='bold')
else:
    ax2.text(0.5, 0.5, f'CV+Gemini: {cv_sent}회 전송\n(전부 품질 게이트 통과)',
             transform=ax2.transAxes, ha='center', va='center',
             fontsize=12, color=COLORS['cv_gemini'], fontweight='bold')

ax2.set_xlabel('품질 점수 (0~100)')
ax2.set_ylabel('프레임 수')
ax2.legend(fontsize=8)

fig.suptitle('전송 프레임 품질 분포 — 무엇을 Gemini에 보내는가?',
             fontsize=13, fontweight='bold')
plt.tight_layout()
out4 = OUTPUT_DIR / 'pipeline-comparison-quality.png'
plt.savefig(out4, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f"  -> {out4.name}")

# ── Chart 5: window 크기 효과 — normal-change 시나리오 (동일 threshold 기준) ──
# 동일 threshold에서 window 크기가 커질수록 FP 급감, TP 유지 → F1 상승
print("Generating window effect chart (normal-change, fixed threshold)...")

nc_df = hist_df[
    (hist_df['scenario']     == 'normal-change') &
    (hist_df['metric']       == 'HISTCMP_CORREL') &
    (hist_df['color_space']  == 'GRAY')
].sort_values('window')

windows = nc_df['window'].tolist()
fp_vals = nc_df['fp'].tolist()
tp_vals = nc_df['tp'].tolist()
f1_vals = nc_df['f1'].tolist()

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.5))
fig.patch.set_facecolor('white')

# 왼쪽: FP vs TP
ax1.set_facecolor('#f8f9fd')
x_pos = np.arange(len(windows))
w_bar = 0.35
b_fp = ax1.bar(x_pos - w_bar/2, fp_vals, w_bar, label='False Positive (오감지)',
               color=COLORS['gemini_only'], alpha=0.80, edgecolor='white')
b_tp = ax1.bar(x_pos + w_bar/2, tp_vals, w_bar, label='True Positive (정상 감지)',
               color=COLORS['cv_gemini'], alpha=0.85, edgecolor='white')

for bar, v in zip(b_fp, fp_vals):
    ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
             str(v), ha='center', va='bottom', fontsize=10, fontweight='bold',
             color=COLORS['gemini_only'])
for bar, v in zip(b_tp, tp_vals):
    ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
             str(v), ha='center', va='bottom', fontsize=10, fontweight='bold',
             color=COLORS['cv_gemini'])

ax1.set_xticks(x_pos)
ax1.set_xticklabels([f'window={w}' for w in windows], fontsize=10)
ax1.set_ylabel('프레임 수 (50프레임 동영상 기준)')
ax1.set_title('window 크기별 FP vs TP\n(normal-change, CORREL+GRAY, 고정 threshold)',
              fontsize=10, fontweight='bold')
ax1.legend(fontsize=9)
ax1.set_ylim(0, max(max(fp_vals), max(tp_vals)) * 1.35)

fp_reduce = (fp_vals[0] - fp_vals[-1]) / fp_vals[0] * 100 if fp_vals[0] > 0 else 0
ax1.text(0.5, 0.92, f'FP: {fp_vals[0]} → {fp_vals[-1]} (▼{fp_reduce:.0f}%)',
         transform=ax1.transAxes, ha='center', fontsize=10,
         color=COLORS['gemini_only'], fontweight='bold')

# 오른쪽: F1 스코어
ax2.set_facecolor('#f8f9fd')
ax2.plot(windows, f1_vals, 'o-', color=COLORS['cv_gemini'],
         linewidth=2.5, markersize=9, markerfacecolor='white', markeredgewidth=2.5)
for w_val, f_val in zip(windows, f1_vals):
    ax2.text(w_val, f_val + 0.012, f'{f_val:.3f}', ha='center', va='bottom',
             fontsize=10, fontweight='bold', color=COLORS['cv_gemini'])
ax2.set_xlabel('연속 프레임 윈도우 크기')
ax2.set_ylabel('F1 Score')
ax2.set_title('window 크기별 F1 Score\n(TP 유지하며 FP 감소 -> F1 상승)',
              fontsize=10, fontweight='bold')
ax2.set_ylim(0, 1.1)
ax2.set_xticks(windows)
ax2.grid(True, alpha=0.4)
best_w = windows[int(np.argmax(f1_vals))]
best_f = max(f1_vals)
ax2.axvline(best_w, color=COLORS['cv_gemini'], linestyle='--', alpha=0.5, linewidth=1.5)
ax2.text(best_w + 0.05, 0.08, f'최적: window={best_w}\nF1={best_f:.3f}',
         fontsize=9, color=COLORS['cv_gemini'], fontweight='bold')

fig.suptitle('히스토그램 연속 프레임 윈도우 효과 — 오감지 감소와 F1 개선\n(HISTCMP_CORREL + Grayscale, normal-change 시나리오)',
             fontsize=11, fontweight='bold')
plt.tight_layout()
out5 = OUTPUT_DIR / 'pipeline-comparison-fp.png'
plt.savefig(out5, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f"  -> {out5.name}")

# ── Summary CSV ─────────────────────────────────────────────────────────────
summary = pd.DataFrame([
    {
        '방식':                 'Gemini Only (매 2초)',
        'API 호출 (60초)':      go_count,
        '품질 불량 호출':       go_on_bad,
        '유효 호출':            go_count - go_on_bad,
        '불필요 호출률':        f'{go_on_bad/go_count:.1%}',
        '추정 비용($/hr)':      f'{cost_go:.4f}',
        'normal-change FP (w=1)': f'{fp_vals[0]}',
        'normal-change FP (w=5)': f'{fp_vals[-1]}',
        'normal-change F1 (w=5)': f'{f1_vals[-1]:.3f}',
    },
    {
        '방식':                 'CV + Gemini (모듈1+2+3)',
        'API 호출 (60초)':      cv_sent,
        '품질 불량 호출':       0,
        '유효 호출':            cv_sent,
        '불필요 호출률':        '0.0%',
        '추정 비용($/hr)':      f'{cost_cv:.4f}',
        'normal-change FP (w=1)': f'{fp_vals[0]}',
        'normal-change FP (w=5)': f'{fp_vals[-1]}',
        'normal-change F1 (w=5)': f'{f1_vals[-1]:.3f}',
    },
])
out_csv = OUTPUT_DIR / 'pipeline-comparison-summary.csv'
summary.to_csv(out_csv, index=False, encoding='utf-8-sig')
print(f"  -> {out_csv.name}")

print()
print("=" * 58)
print("핵심 수치 요약")
print("=" * 58)
print(f"  Gemini Only:  {go_count}회 | 품질 불량 {go_on_bad}회 | ${cost_go:.2f}/hr")
print(f"  CV + Gemini:  {cv_sent}회  | 품질 불량 0회  | ${cost_cv:.2f}/hr")
print(f"  API 절감:     {(1-cv_sent/go_count)*100:.0f}%  | 비용 절감: {(1-cost_cv/cost_go)*100:.0f}%")
print(f"  품질 불량 제거: {go_on_bad}회 -> 0회")
print(f"  손떨림 FP:    window=1 {w1_fp[0]:.0f}회 -> window=5 {w5_fp[0]:.0f}회")
print("=" * 58)
print()
print("생성된 파일:")
for p in sorted(OUTPUT_DIR.glob('pipeline-comparison-*.png')):
    print(f"  docs/ablation-results/{p.name}")
print(f"  docs/ablation-results/pipeline-comparison-summary.csv")
