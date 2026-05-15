# 노트북 1 — BIOS 화면 End-to-End 파이프라인 (가이드)

> 실제 `.ipynb` 파일은 Codex 또는 Claude가 이 가이드를 보고 생성합니다.
> 이 문서는 노트북이 다뤄야 할 셀 구성과 산출물을 정의합니다.

## 목표
BIOS 화면 사진 → 정면화 → 대비 강화 → 이진화 → 텍스트 추출 → 메뉴 매칭의
전체 파이프라인을 OpenCV-Python으로 구성하고, 각 단계의 기여도를 측정한다.

## 입력 데이터
- `data/bios/<vendor>/*.jpg`
  - `vendor ∈ {ami, award, phoenix, other}`
  - 각 vendor당 최소 5장, 다양한 각도(0/15/30/45도)와 조명 포함
- `data/bios/ground-truth.csv`: 파일별 정답 텍스트(상위 메뉴 항목)

## 셀 구성

1. **셋업**: 라이브러리 import, 데이터 경로 정의, matplotlib 한글 폰트 설정
2. **단계 1 — Hough Line 모서리 검출**
   - `cv2.Canny` → `cv2.HoughLinesP`
   - 4개 경계 후보 시각화
3. **단계 2 — Homography 정면화**
   - 4개 꼭짓점 추정 + `cv2.getPerspectiveTransform`
   - 원본 vs 정면화 결과 비교 시각화
4. **단계 3 — CLAHE 대비 강화**
   - `cv2.createCLAHE(clipLimit=[1,2,4,8], tileGridSize=(8,8))` 그리드 서치
   - 입력 히스토그램 vs 출력 히스토그램
5. **단계 4 — 이진화 비교**
   - `cv2.threshold(THRESH_OTSU)` vs `cv2.adaptiveThreshold(GAUSSIAN_C)` vs `MEAN_C`
   - 각 방법별 결과 갤러리
6. **단계 5 — Connected Components**
   - `cv2.connectedComponentsWithStats`로 텍스트 영역 분리
   - 너무 작거나 큰 컴포넌트 필터링
7. **단계 6 — OCR**
   - `pytesseract.image_to_string(lang='eng', config='--psm 6')`
   - 결과 텍스트 + 정답 비교
8. **Ablation 측정**
   - 각 전처리 단계 on/off 16가지 조합
   - 정확도 = Levenshtein 유사도 ≥ 0.8 비율
   - **표 출력 → `docs/ablation-results/bios-pipeline-ablation.csv`**
9. **시각화 저장**
   - 단계별 처리 결과 합성 이미지 → `docs/cv-pipeline/bios-pipeline-stages.png`
   - Threshold 방법 비교 → `docs/cv-pipeline/bios-threshold-comparison.png`
   - 각도별 정확도 그래프 → `docs/ablation-results/bios-angle-accuracy.png`
   - CLAHE 그리드 서치 히트맵 → `docs/ablation-results/bios-clahe-gridsearch.png`

## OpenCV.js 이식 메모
- Tesseract.js는 별도 npm 패키지 — `npm install tesseract.js`
- Homography 4점 자동 검출 부분이 가장 까다로움 — Python에서 robust한 휴리스틱 확보 후 이식

## 참고 문헌 (README에 명시할 것)
- Hough, P. V. C. (1962). "Method and Means for Recognizing Complex Patterns"
- Pizer et al. (1987). "Adaptive histogram equalization and its variations"
- Otsu, N. (1979). "A threshold selection method from gray-level histograms"
- Bradley & Roth (2007). "Adaptive Thresholding using the Integral Image"
- Smith, R. (2007). "An Overview of the Tesseract OCR Engine"
