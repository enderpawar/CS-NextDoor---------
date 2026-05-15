# ablation-results/ — 정량 평가 결과

노트북에서 생성된 정량 결과(CSV + PNG).
**README의 점수 결정 요소는 여기 데이터의 양과 품질입니다.**

## 예정 파일

### 모듈 1 (BIOS 파이프라인)
| 파일 | 내용 |
|---|---|
| `bios-pipeline-ablation.csv` | 전처리 단계 16조합 × OCR 정확도 |
| `bios-angle-accuracy.png` | 카메라 각도(0/15/30/45°) 정확도 |
| `bios-clahe-gridsearch.png` | CLAHE clipLimit × tileSize 히트맵 |
| `bios-threshold-methods.csv` | Otsu / Gaussian / Mean 비교 |

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
### 모듈 1 — BIOS 파이프라인 Ablation Study

각 전처리 단계가 최종 OCR 정확도에 미치는 영향:

![BIOS Ablation](docs/ablation-results/bios-pipeline-ablation.png)

| 단계 조합 | 정확도 | Δ vs baseline |
|---|---|---|
| 원본만 | 47.3% | - |
| + CLAHE | 62.8% | +15.5%p |
| + CLAHE + Adaptive Threshold | 81.4% | +34.1%p |
| 전체 파이프라인 | 89.2% | +41.9%p |

자세한 데이터: [bios-pipeline-ablation.csv](docs/ablation-results/bios-pipeline-ablation.csv)
```
