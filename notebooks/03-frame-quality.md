# 노트북 3 — 프레임 품질 사전 필터 (가이드)

## 목표
Gemini 호출 직전, 품질이 나쁜 프레임(블러/과노출/심한 흔들림)을 필터링하여
**비용 절감 + 정확도 보존**을 정량 측정한다.

## 입력 데이터
- `data/live-frames/quality-mix/*.jpg` — 정상/블러/과노출/저조도/흔들림 혼합 200장
- `data/live-frames/quality-mix/labels.csv` — 각 이미지의 품질 라벨(good/bad)

## 셀 구성

1. **셋업** + 라벨 로딩
2. **블러 검출 두 방법 비교**
   - 방법 A: Laplacian variance — `cv2.Laplacian(gray, cv2.CV_64F).var()`
   - 방법 B: FFT 고주파 비율 — 푸리에 변환 후 고주파 영역 에너지 비율
3. **밝기/대비 통계**
   - `cv2.meanStdDev(gray)` — 평균/표준편차
   - 극단값 임계 정의
4. **Optical Flow (흔들림 검출)**
   - `cv2.calcOpticalFlowFarneback`로 인접 프레임 흐름 크기 측정
5. **단일 메트릭별 ROC**
6. **결합 필터 설계**
   - Laplacian < T1 OR brightness 극단 OR flow > T2 → 거부
   - 그리드 서치로 최적 임계값
7. **비용 절감 정량화**
   - 필터 통과율 × 평균 호출 비용 = 절감액 시뮬레이션
   - 거부된 프레임 중 실제 유효 프레임 비율 (오거부율)
8. **시각화 저장**
   - 방법 비교 ROC → `docs/ablation-results/quality-blur-comparison.png`
   - 임계값 튜닝 그래프 → `docs/ablation-results/quality-threshold-tuning.png`
   - 거부 사례 갤러리 → `docs/cv-pipeline/quality-rejected-samples.png`

## OpenCV.js 이식 메모
- `src/lib/cv/frameMetrics.ts`에 이미 `laplacianVariance` / `brightnessStdDev` 등 골격 존재
- Optical Flow는 OpenCV.js에서도 사용 가능하지만 비용 큼 — 필요 시에만
- 결정된 임계값을 const로 export

## 참고 문헌
- Pertuz et al. (2013). "Analysis of focus measure operators for shape-from-focus"
- Farnebäck, G. (2003). "Two-Frame Motion Estimation Based on Polynomial Expansion"
