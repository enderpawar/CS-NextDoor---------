# Notebooks — Python 실험 환경

OpenCV-Python(Jupyter)으로 알고리즘을 검증한 뒤 OpenCV.js로 이식합니다.
**모든 README용 정량 그래프/표는 여기서 생성됩니다.**

## 작업 흐름

```
Python (Jupyter)에서 실험 + ablation 측정 + 그래프 생성
  ↓
검증된 파이프라인을 OpenCV.js로 1:1 이식 (src/lib/cv/, src/hooks/)
  ↓
샘플 1~2개로 결과 일치 확인
  ↓
README에 Python 그래프 임베드 + OpenCV.js 런타임 영상 demo
```

## 환경 셋업

```bash
# 권장: conda 또는 venv
python -m venv .venv
.venv\Scripts\activate          # Windows PowerShell
pip install -r requirements.txt
jupyter lab
```

`requirements.txt`:

```
opencv-python>=4.9
numpy
matplotlib
seaborn
pytesseract        # 모듈 1 OCR (시스템에 Tesseract 설치 필요)
scikit-learn       # ROC, Precision/Recall
pandas
jupyter
ipywidgets
```

## 노트북 계획

| 노트북 | 모듈 | 목표 산출물 |
|---|---|---|
| `01-bios-pipeline.ipynb` | 모듈 1 | 단계별 처리 갤러리 + OCR 정확도 ablation 표 |
| `02-histogram-analysis.ipynb` | 모듈 2 | 4×3×3 메트릭/컬러/윈도우 히트맵 + 시나리오별 ROC |
| `03-frame-quality.ipynb` | 모듈 3 | Laplacian/FFT/Optical Flow 비교 + 비용 절감 그래프 |
| `04-beep-spectrogram.ipynb` | 모듈 4 (선택) | 멜 스펙트로그램 시각화 + 분류 정확도 |

각 노트북 끝에 **README 임베드용 PNG**를 `docs/cv-pipeline/` 또는 `docs/ablation-results/`에 저장합니다.

## OpenCV.js로 이식할 때

| Python | OpenCV.js |
|---|---|
| `cv2.imread()` | `cv.imread(canvas)` (canvas 사전 준비) |
| `np.ndarray` | `cv.Mat` (수동 `.delete()`) |
| `cv2.HoughLinesP(...)` | `cv.HoughLinesP(edges, lines, ...)` (Mat 출력 인자) |
| `cv2.findHomography(src, dst)` | `cv.findHomography(srcMat, dstMat)` |
| `cv2.adaptiveThreshold(...)` | `cv.adaptiveThreshold(...)` |
| `cv2.calcHist([img], [0], None, [256], [0,256])` | `cv.calcHist(matVector, [0], mask, hist, sizes, ranges)` |

> ⚠️ OpenCV.js는 출력 Mat을 인자로 받는 패턴이 많습니다. Python 반환값 패턴과 다름.

## 데이터셋

`data/` 디렉토리 참조. 본인 PC + YouTube 캡처 + 합성으로 수집.

## 라이선스 / 출처

OpenCV-Python 함수 사용 시 README References 섹션에 출처 명시.
