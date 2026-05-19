# ablation-results/ — 정량 평가 결과

노트북에서 생성된 정량 결과(CSV + PNG)입니다.
**README의 점수 결정 요소는 여기 데이터의 양과 품질입니다.**

> 2026-05-19 기준 README에는 실제 촬영 BIOS 22장 결과를 우선 사용합니다.
> synthetic/Wikimedia 결과는 알고리즘 점검용으로 남겨두고, 로컬 Tesseract가 없어 0으로 찍힌 OCR 그래프는 평가 근거로 사용하지 않습니다.

## 예정 파일

### 모듈 1 (BIOS 파이프라인)
| 파일 | 내용 | 데이터 소스 |
|---|---|---|
| `bios-ablation.csv` / `bios-pipeline-ablation.csv` | 전처리 16조합 × 평균 텍스트-ROI 후보 수 | **실촬영 22장** (proxy 측정) |
| `bios-ablation.png` | 16조합 막대그래프 (전체 파이프라인 빨간 강조) | **실촬영 22장** |
| `bios-clahe-gridsearch.csv` / `.png` | CLAHE clipLimit × tileSize × block × C 144조합 히트맵 | **실촬영 22장** |
| `bios-angle-accuracy.png` | (Tesseract 미설치로 미측정 — 향후 OCR 환경에서 재생성) | — |
| `bios-corner-detection.csv` | 합성 데이터 기반 quad 검출 IoU 요약(보존용) | synthetic + web fixtures |
| `real-bios-*.csv` | 실촬영 평가 raw 결과 | **실촬영 22장** |

### AR 화면 외곽 검출 요약

`preprocessBiosFrameForGuide().corners`의 Hough + RANSAC homography 검출 성공률을 각도별로
분리해 기록했습니다. IoU는 수동/합성 ground-truth 사각형 대비 검출 polygon의 겹침 비율입니다.

| 데이터셋 | 각도 | 샘플 | 검출률 | 평균 IoU |
|---|---:|---:|---:|---:|
| synthetic-bios | 0° | 5 | 100% | 0.94 |
| synthetic-bios | 15° | 5 | 100% | 0.91 |
| synthetic-bios | 30° | 5 | 80% | 0.84 |
| synthetic-bios | 45° | 5 | 60% | 0.72 |
| web-bios-fixtures | mixed | 5 | 80% | 0.81 |

자세한 데이터: [bios-corner-detection.csv](bios-corner-detection.csv)

### Real-Capture BIOS 평가 패키지

텀프로젝트 제출 시에는 synthetic/Web fixture 결과보다 실제 카메라 입력 평가가 더 중요합니다.  
`data/bios/real-capture/ground-truth.csv`는 MSI Click BIOS 5 화면 2종을 22개 stress case로 촬영하는 계획과 정답 텍스트를 담습니다.

| 결과 파일 | 내용 |
|---|---|
| `real-bios-summary.csv` | 22장 실촬영 평가 세트 요약 |
| `real-bios-quality-results.csv` | Laplacian variance, sharpness, brightness 기반 good/bad 판정 |
| `real-bios-corner-results.csv` | Canny/Hough/contour 기반 BIOS 외곽 검출 결과 |
| `real-bios-ocr-results.csv` | raw OCR vs CLAHE+AdaptiveThreshold OCR 유사도 |
| `real-video-frame-results.csv` | 실제 영상 프레임의 품질 gate + 변화 감지 결과 |

#### 2026-05-19 Real-Capture 결과 요약

| 지표 | 결과 | 비고 |
|---|---:|---|
| 실촬영 이미지 | 22장 | `C:\Users\user\Desktop\test data` |
| 품질 게이트 통과 | 8/22 (36.4%) | Gemini/OCR 후보 프레임 |
| 품질 게이트 거부 | 14/22 (63.6%) | 반사/블러/저품질 프레임 필터링 |
| 평균 sharpness score | 0.036 | 범위 0.007~0.092 |
| 평균 Laplacian variance | 57.5 | 범위 11.1~147.2 |
| 평균 brightness | 0.418 | 범위 0.134~0.625 |
| ROI/corner 후보 검출 | 14/22 (63.6%) | strict quad 0건, fallback ROI 14건 |
| 평균 Hough line 후보 | 740.2개 | 범위 42~3946 |
| 평균 텍스트/에지 ROI 후보 | 425.1개 | 범위 186~869 |
| OCR availability | 0/22 (0.0%) | 로컬 Tesseract 미설치 |

실행:

```powershell
python notebooks/evaluate_real_capture_dataset.py --image-dir "C:\Users\user\Desktop\test data"
```

시각화:

![Real BIOS Summary](../cv-pipeline/real-bios-summary-chart.svg)

![Real BIOS ROI Overlay](../cv-pipeline/real-bios-overlay-grid.png)

![Real BIOS Preprocess Comparison](../cv-pipeline/real-bios-preprocess-comparison.png)

주의: 촬영 파일이 없는 상태에서는 빈 CSV와 상태 안내 차트만 생성됩니다. 평가용 README에는 실제 촬영 이미지로 다시 생성된 요약 차트와 오버레이 이미지만 사용합니다.

### 모듈 2 (히스토그램 변화 감지)
| 파일 | 내용 |
|---|---|
| `histogram-heatmap.png` | 4 메트릭 × 3 컬러 × 3 윈도우 정확도 히트맵 |
| `histogram-roc-per-scenario.png` | 시나리오 5종 ROC 곡선 |
| `histogram-accuracy.csv` | 36조합 raw 데이터 |

### 모듈 3 (프레임 품질)
| 파일 | 내용 |
|---|---|
| `quality-blur-comparison.png` | Laplacian vs FFT vs Sobel 블러 검출 ROC |
| `quality-threshold-tuning.png` | 임계값 vs 거부율/손실률 트레이드오프 |
| `quality-cost-savings.csv` | 필터 적용 전후 Gemini 호출 절감 시뮬레이션 |

### 모듈 4 (비프음, 선택)
| 파일 | 내용 |
|---|---|
| `beep-methods-comparison.png` | Template Matching vs DTW 정확도 |
| `beep-noise-robustness.png` | SNR 30/20/10dB 강건성 |
| `beep-confusion-matrix.png` | 패턴 분류 혼동행렬 |

## README 인용 형식

```markdown
### 모듈 1 — Real-Capture BIOS Evaluation

실제 촬영 BIOS 22장에 대해 OpenCV 품질 게이트와 ROI 후보 검출을 측정했습니다.

![Real BIOS OpenCV Summary](docs/cv-pipeline/real-bios-summary-chart.svg)

| 지표 | 결과 | 해석 |
|---|---|---|
| 품질 게이트 통과 | 8/22 (36.4%) | Gemini/OCR 후보 프레임 |
| 품질 게이트 거부 | 14/22 (63.6%) | 저품질 프레임 필터링 |
| ROI/corner 후보 검출 | 14/22 (63.6%) | BIOS 영역 후보 생성 |
| 평균 텍스트/에지 ROI 후보 | 425.1개 | OCR/Vision 전달 전 후보 영역 |

자세한 데이터: [real-bios-summary.csv](docs/ablation-results/real-bios-summary.csv)
```
