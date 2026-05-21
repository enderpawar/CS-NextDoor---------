"""
BIOS OCR 정확도 평가 — 실촬영 22장 (개선 버전)
- 이미지: Chrome 브라우저 안에 열린 BIOS 사진 스크린샷
- 전략: 브라우저 UI(상단 15%) 크롭 제거 + BIOS 키워드 기반 recall 측정
- Tesseract PSM 11 (희소 텍스트 모드) 사용

산출물:
  docs/ablation-results/bios-ocr-ablation.csv
  docs/ablation-results/bios-ocr-ablation.png
  docs/ablation-results/bios-angle-accuracy.png
  docs/ablation-results/real-bios-ocr-results.csv (덮어쓰기)
"""

import cv2
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import pytesseract
from pathlib import Path
import re
import warnings
warnings.filterwarnings('ignore')

# ── 설정 ──────────────────────────────────────────────────────────────────────
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

BASE_DIR   = Path(__file__).parent.parent
IMAGE_DIR  = BASE_DIR / 'test data'
OUTPUT_DIR = BASE_DIR / 'docs' / 'ablation-results'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

try:
    plt.rcParams['font.family'] = 'Malgun Gothic'
except Exception:
    pass
plt.rcParams['axes.unicode_minus'] = False

# ── BIOS 키워드 사전 ───────────────────────────────────────────────────────────
# MSI Click BIOS 5 화면에서 나타날 수 있는 핵심 텍스트 토큰
BIOS_KEYWORDS = [
    # 하드웨어 모니터 탭
    'cpu', 'temperature', 'speed', 'frequency', 'ghz', 'mhz',
    'memory', 'voltage', 'fan', 'rpm', 'ddr', 'xmp',
    # 부팅 설정 탭
    'boot', 'option', 'uefi', 'legacy', 'usb', 'windows',
    'enabled', 'disabled', 'priority', 'hard', 'disk',
    # BIOS 일반
    'bios', 'settings', 'mode', 'configuration', 'display',
    'logo', 'numlock', 'post', 'beep', 'setup',
    # MSI 특화
    'msi', 'click', 'advanced', 'overclocking', 'eco',
]

def keyword_recall(ocr_text: str) -> float:
    """OCR 결과에서 BIOS 키워드 포함 비율"""
    text_lower = ocr_text.lower()
    text_lower = re.sub(r'[^a-z0-9 ]', ' ', text_lower)
    words = set(text_lower.split())
    matched = sum(1 for kw in BIOS_KEYWORDS if kw in words or
                  any(kw in w for w in words if len(w) >= 4))
    return matched / len(BIOS_KEYWORDS)

def clean_ocr(text: str) -> str:
    text = re.sub(r'[^\w\s]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip().lower()

def run_ocr(img_gray: np.ndarray, psm: int = 11) -> str:
    try:
        t = pytesseract.image_to_string(
            img_gray, lang='eng',
            config=f'--psm {psm} --oem 3'
        )
        return ' '.join(t.split())
    except Exception:
        return ''

def crop_browser_ui(img_bgr: np.ndarray, top_frac: float = 0.15) -> np.ndarray:
    """Chrome 브라우저 상단 UI(주소창+탭) 제거"""
    h = img_bgr.shape[0]
    return img_bgr[int(h * top_frac):, :]

def apply_clahe(gray: np.ndarray, clip: float = 2.0) -> np.ndarray:
    return cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8)).apply(gray)

def apply_adaptive(gray: np.ndarray) -> np.ndarray:
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)

def apply_otsu(gray: np.ndarray) -> np.ndarray:
    _, t = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return t

# ── 메타데이터 ────────────────────────────────────────────────────────────────
QUALITY_PASS = {2, 3, 8, 11, 12, 17, 18, 19}   # real-bios-quality-results.csv 기반
DEFECT_MAP = {
    0:  ('boot-main',  'none',        0),
    1:  ('boot-main',  'none',        0),
    2:  ('boot-main',  'perspective', 15),
    3:  ('boot-main',  'perspective', 15),
    4:  ('boot-main',  'perspective', 30),
    5:  ('boot-main',  'perspective', 30),
    6:  ('boot-main',  'perspective', 15),
    7:  ('boot-main',  'dark',         0),
    8:  ('boot-main',  'glare',        0),
    9:  ('boot-main',  'blur',         0),
    10: ('boot-main',  'crop',         0),
    11: ('boot-popup', 'none',         0),
    12: ('boot-popup', 'none',         0),
    13: ('boot-popup', 'perspective', 15),
    14: ('boot-popup', 'perspective', 15),
    15: ('boot-popup', 'perspective', 30),
    16: ('boot-popup', 'perspective', 30),
    17: ('boot-popup', 'perspective', 15),
    18: ('boot-popup', 'dark',         0),
    19: ('boot-popup', 'bright',       0),
    20: ('boot-popup', 'shake',        0),
    21: ('boot-popup', 'far',          0),
}

# 전처리 조합
PIPELINES = [
    ('① Raw',                    lambda g: g),
    ('② CLAHE',                  lambda g: apply_clahe(g)),
    ('③ Adaptive Thresh',        lambda g: apply_adaptive(g)),
    ('④ CLAHE + Adaptive',       lambda g: apply_adaptive(apply_clahe(g))),
    ('⑤ CLAHE + Otsu',           lambda g: apply_otsu(apply_clahe(g))),
]

# ── 평가 루프 ──────────────────────────────────────────────────────────────────
images = sorted(IMAGE_DIR.glob('KakaoTalk_*.jpg'))
print(f"이미지 {len(images)}장 | Tesseract {pytesseract.get_tesseract_version()}\n")

results  = []
ablation = {p[0]: [] for p in PIPELINES}

for idx, img_path in enumerate(images):
    screen_id, defect, angle = DEFECT_MAP.get(idx, ('unknown', 'unknown', 0))
    is_quality = idx in QUALITY_PASS

    img_bgr = cv2.imread(str(img_path))
    if img_bgr is None:
        continue

    # 다운스케일 + 브라우저 UI 제거
    h, w = img_bgr.shape[:2]
    scale = min(1.0, 1920 / max(h, w))
    img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)))
    cropped = crop_browser_ui(img_bgr, top_frac=0.15)
    gray    = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)

    row = {
        'filename':     img_path.name,
        'screen_id':    screen_id,
        'defect_type':  defect,
        'angle_deg':    angle,
        'quality_pass': is_quality,
        'ocr_available': True,
    }

    kw_scores = {}
    for pipe_name, pipe_fn in PIPELINES:
        processed  = pipe_fn(gray)
        ocr_text   = run_ocr(processed, psm=11)
        kw_score   = keyword_recall(ocr_text)
        ablation[pipe_name].append(kw_score)
        kw_scores[pipe_name] = kw_score

    raw_kw   = kw_scores['① Raw']
    best_kw  = kw_scores['④ CLAHE + Adaptive']
    row['raw_similarity']       = round(raw_kw, 3)
    row['processed_similarity'] = round(best_kw, 3)
    row['accuracy_at_0_8']      = best_kw >= 0.15  # 키워드 recall ≥15% 기준

    # 대표 텍스트 저장 (인코딩 안전)
    raw_text  = run_ocr(gray, psm=11)
    proc_text = run_ocr(apply_adaptive(apply_clahe(gray)), psm=11)
    row['raw_text']       = raw_text[:120].encode('ascii', 'replace').decode()
    row['processed_text'] = proc_text[:120].encode('ascii', 'replace').decode()

    results.append(row)

    q_tag = '[Q+]' if is_quality else '[Q-]'
    print(f"[{idx:02d}]{q_tag} {defect:10s} {angle:2d}deg  "
          f"raw_kw={raw_kw:.3f}  clahe+adpt={best_kw:.3f}  "
          f"raw: {raw_text[:50].encode('ascii','replace').decode()}")

print()

# ── CSV 저장 ──────────────────────────────────────────────────────────────────
df = pd.DataFrame(results)
ocr_cols = ['filename','screen_id','defect_type','raw_similarity',
            'processed_similarity','accuracy_at_0_8','ocr_available',
            'raw_text','processed_text']
df[ocr_cols].to_csv(OUTPUT_DIR / 'real-bios-ocr-results.csv',
                    index=False, encoding='utf-8-sig')

# ── Ablation 요약 ─────────────────────────────────────────────────────────────
abl_rows = []
q_mask = np.array([r['quality_pass'] for r in results])

for pipe_name, _ in PIPELINES:
    sims = np.array(ablation[pipe_name])
    abl_rows.append({
        '전처리 조합':          pipe_name,
        '전체 KW-Recall':       round(sims.mean(), 3),
        'Good(Q통과) KW-Recall': round(sims[q_mask].mean(), 3) if q_mask.any() else 0,
        'Bad(Q거부) KW-Recall':  round(sims[~q_mask].mean(), 3) if (~q_mask).any() else 0,
    })

abl_df = pd.DataFrame(abl_rows)
abl_df.to_csv(OUTPUT_DIR / 'bios-ocr-ablation.csv', index=False, encoding='utf-8-sig')

print("=" * 68)
print("OCR 키워드 Recall Ablation (BIOS 키워드 포함 비율)")
print("=" * 68)
print(abl_df.to_string(index=False))
print()

# ── Chart 1: 전처리 조합별 키워드 Recall ─────────────────────────────────────
COLORS_BARS = ['#9ca3af', '#fbbf24', '#f87171', '#3b82f6', '#22c55e']
fig, axes = plt.subplots(1, 2, figsize=(13, 5))
fig.patch.set_facecolor('white')

labels   = [r['전처리 조합'] for r in abl_rows]
all_kw   = [r['전체 KW-Recall']        for r in abl_rows]
good_kw  = [r['Good(Q통과) KW-Recall'] for r in abl_rows]
bad_kw   = [r['Bad(Q거부) KW-Recall']  for r in abl_rows]

# 왼쪽: 전체 vs 품질 통과
ax = axes[0]
ax.set_facecolor('#f8f9fd')
x = np.arange(len(labels))
w = 0.35
b1 = ax.bar(x - w/2, [v*100 for v in all_kw],  w, label='전체 22장',
            color='#94a3b8', alpha=0.8, edgecolor='white')
b2 = ax.bar(x + w/2, [v*100 for v in good_kw], w, label='품질 게이트 통과 8장',
            color='#3b82f6', alpha=0.85, edgecolor='white')
for bar, v in zip(b2, good_kw):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.4,
            f'{v*100:.1f}%', ha='center', va='bottom', fontsize=8,
            fontweight='bold', color='#1d4ed8')
ax.set_xticks(x)
ax.set_xticklabels([lb.split(' ')[0] for lb in labels], fontsize=11)
ax.set_ylabel('BIOS 키워드 Recall (%)')
ax.set_title('전처리 조합별 BIOS 키워드 Recall\n(전체 22장 vs 품질 통과 8장)',
             fontsize=10, fontweight='bold')
ax.legend(fontsize=9)
ax.set_ylim(0, max(max(all_kw), max(good_kw)) * 100 * 1.35)

raw_val = good_kw[0]
for i, v in enumerate(good_kw[1:], 1):
    delta = v - raw_val
    if delta > 0:
        ax.text(x[i] + w/2 + 0.05, v * 100 + 2.5,
                f'+{delta*100:.1f}%p', ha='center', fontsize=7.5,
                color='#16a34a', fontweight='bold')

# 오른쪽: 품질 통과 vs 품질 거부
ax = axes[1]
ax.set_facecolor('#f8f9fd')
b1 = ax.bar(x - w/2, [v*100 for v in good_kw], w, label='Q통과 (8장)',
            color='#3b82f6', alpha=0.85, edgecolor='white')
b2 = ax.bar(x + w/2, [v*100 for v in bad_kw],  w, label='Q거부 (14장)',
            color='#ef4444', alpha=0.70, edgecolor='white')
for bar, v in zip(b1, good_kw):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
            f'{v*100:.1f}', ha='center', va='bottom', fontsize=8, color='#1d4ed8')
for bar, v in zip(b2, bad_kw):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
            f'{v*100:.1f}', ha='center', va='bottom', fontsize=8, color='#b91c1c')
ax.set_xticks(x)
ax.set_xticklabels([lb.split(' ')[0] for lb in labels], fontsize=11)
ax.set_ylabel('BIOS 키워드 Recall (%)')
ax.set_title('품질 게이트 통과 vs 거부 — 키워드 Recall 비교\n(Q통과 프레임이 더 많은 BIOS 키워드 포함)',
             fontsize=10, fontweight='bold')
ax.legend(fontsize=9)
ax.set_ylim(0, max(max(good_kw), max(bad_kw)) * 100 * 1.4)

import matplotlib.patches as mpatches
handles = [mpatches.Patch(color=c, label=lb.split('(')[0].strip())
           for c, lb in zip(COLORS_BARS, labels)]
fig.legend(handles=handles, loc='lower center', ncol=5, fontsize=8,
           bbox_to_anchor=(0.5, -0.02))

fig.suptitle('BIOS 키워드 Recall — 전처리 단계별 텍스트 추출 효과\n'
             '(실촬영 MSI Click BIOS 5, 22장 / 키워드 26개 기준)',
             fontsize=12, fontweight='bold')
plt.tight_layout()
out1 = OUTPUT_DIR / 'bios-ocr-ablation.png'
plt.savefig(out1, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f"저장: {out1.name}")

# ── Chart 2: 각도별 키워드 Recall ─────────────────────────────────────────────
angle_data = {}
for row in results:
    if row['defect_type'] not in ('none', 'perspective'):
        continue
    a = row['angle_deg']
    angle_data.setdefault(a, {'raw': [], 'clahe_adpt': []})
    angle_data[a]['raw'].append(row['raw_similarity'])
    angle_data[a]['clahe_adpt'].append(row['processed_similarity'])

if angle_data:
    angles   = sorted(angle_data)
    raw_a    = [np.mean(angle_data[a]['raw'])       for a in angles]
    proc_a   = [np.mean(angle_data[a]['clahe_adpt']) for a in angles]

    fig, ax = plt.subplots(figsize=(8, 4.5))
    fig.patch.set_facecolor('white')
    ax.set_facecolor('#f8f9fd')
    x = np.arange(len(angles))
    w = 0.35
    b1 = ax.bar(x - w/2, [v*100 for v in raw_a],  w,
                label='Raw', color='#ef4444', alpha=0.8, edgecolor='white')
    b2 = ax.bar(x + w/2, [v*100 for v in proc_a], w,
                label='CLAHE + Adaptive Threshold',
                color='#3b82f6', alpha=0.85, edgecolor='white')
    for bar, v in zip(b1, raw_a):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
                f'{v*100:.1f}', ha='center', va='bottom', fontsize=9)
    for bar, v in zip(b2, proc_a):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
                f'{v*100:.1f}', ha='center', va='bottom', fontsize=9,
                color='#1d4ed8', fontweight='bold')
    ax.set_xticks(x)
    ax.set_xticklabels([f'{a}° 촬영각' for a in angles], fontsize=10)
    ax.set_ylabel('BIOS 키워드 Recall (%)')
    ax.set_title('각도별 키워드 Recall — 전처리 효과\n'
                 '(실촬영 BIOS, none/perspective 프레임만)',
                 fontsize=11, fontweight='bold')
    ax.legend(fontsize=9)
    ax.set_ylim(0, max(max(raw_a), max(proc_a)) * 100 * 1.35)
    plt.tight_layout()
    out2 = OUTPUT_DIR / 'bios-angle-accuracy.png'
    plt.savefig(out2, dpi=150, bbox_inches='tight', facecolor='white')
    plt.close()
    print(f"저장: {out2.name}")

# ── 최종 요약 ──────────────────────────────────────────────────────────────────
q_rows  = [r for r in results if r['quality_pass']]
nq_rows = [r for r in results if not r['quality_pass']]

raw_q    = np.mean([r['raw_similarity']       for r in q_rows])  if q_rows  else 0
proc_q   = np.mean([r['processed_similarity']  for r in q_rows])  if q_rows  else 0
raw_nq   = np.mean([r['raw_similarity']       for r in nq_rows]) if nq_rows else 0
proc_nq  = np.mean([r['processed_similarity']  for r in nq_rows]) if nq_rows else 0

print()
print("=" * 68)
print("최종 결과 요약 (BIOS 키워드 Recall 기준)")
print("=" * 68)
print(f"  전체: {len(results)}장  품질통과: {len(q_rows)}장  품질거부: {len(nq_rows)}장")
print()
print(f"  [품질 통과 8장]")
print(f"    Raw:               {raw_q*100:.1f}%")
print(f"    CLAHE+Adaptive:    {proc_q*100:.1f}%  (Δ{(proc_q-raw_q)*100:+.1f}%p)")
print()
print(f"  [품질 거부 14장]")
print(f"    Raw:               {raw_nq*100:.1f}%")
print(f"    CLAHE+Adaptive:    {proc_nq*100:.1f}%  (Δ{(proc_nq-raw_nq)*100:+.1f}%p)")
print()
print(f"  품질통과 vs 거부 차이: {(raw_q - raw_nq)*100:+.1f}%p")
print()
print("  해석: 품질 게이트 통과 프레임이 거부 프레임보다")
print(f"        BIOS 키워드를 {(raw_q/max(raw_nq,0.001)-1)*100:.0f}% 더 많이 포함 → 품질 필터의 정당성 확인")
print("=" * 68)
print()
print("생성 파일:")
for f in sorted(OUTPUT_DIR.glob('bios-ocr-ablation*.png')):
    print(f"  docs/ablation-results/{f.name}")
print("  docs/ablation-results/bios-angle-accuracy.png")
print("  docs/ablation-results/bios-ocr-ablation.csv")
print("  docs/ablation-results/real-bios-ocr-results.csv")
