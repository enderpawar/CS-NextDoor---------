# 노트북 2 — 라이브 프레임 변화 감지 정량 분석 (가이드)

## 목표
Phase 7-B 라이브 가이드 모드의 히스토그램 변화 감지를
**메트릭 × 컬러 공간 × 안정화 윈도우** 매트릭스로 정량 평가한다.

## 입력 데이터
- `data/live-frames/<scenario>/*.mp4`
  - `scenario ∈ {normal-change, hand-shake, lighting, rolling-shutter, ios-autofocus}`
- `data/live-frames/<scenario>/ground-truth.csv`
  - 각 영상에서 "실제 화면 전환이 발생한 timestamp" 수동 라벨링

## 셀 구성

1. **셋업** + 라벨 로딩
2. **프레임 추출**: 영상 → 매초 N프레임 (예: 10fps) → numpy 배열로 저장
3. **히스토그램 계산**: 컬러 공간 3종(RGB / HSV / Grayscale) × 채널 분할
4. **메트릭 비교 매트릭스**: 36개 조합
   - 메트릭: `HISTCMP_CORREL` / `CHISQR` / `BHATTACHARYYA` / `INTERSECT`
   - 컬러 공간: RGB / HSV / Grayscale
   - 안정화 윈도우: 1프레임 / 3프레임 / 5프레임 연속
5. **각 조합별 정확도 계산**
   - TP/FP/FN/TN 카운트
   - Precision / Recall / F1
6. **ROC 곡선 그리기** (시나리오별)
7. **시각화 저장**
   - 36개 조합 히트맵 → `docs/ablation-results/histogram-heatmap.png`
   - 시나리오별 ROC → `docs/ablation-results/histogram-roc-per-scenario.png`
   - False Positive 사례 5장 → `docs/cv-pipeline/histogram-false-positives.png`

## OpenCV.js 이식 메모
- Phase 7-B `useLiveFrameCapture.ts`에 이미 골격 있음 (`snippets.md` 참고)
- 결정된 베스트 조합의 파라미터만 코드에 반영
- `changeCountRef`로 3프레임 연속 확인 (이미 설계됨)

## 참고 문헌
- OpenCV docs: `cv::compareHist` (https://docs.opencv.org)
- Swain & Ballard (1991). "Color Indexing" — 히스토그램 매칭 원조
