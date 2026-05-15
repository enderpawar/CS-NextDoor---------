# Handoff: CV 모듈 Python 노트북 + ablation 측정

- From: claude
- To:   codex
- Date: 2026-05-15

## 목표
Python(Jupyter)에서 CV 모듈 1/2/3 알고리즘 검증 + ablation 측정 + README용 그래프 생성.

## 현재 상태

### Claude가 완성한 것 (OpenCV.js 이식 완료)
- ✅ `src/lib/cv/biosPipeline.ts` — 모듈 1 (Hough+Homography+CLAHE+AdaptiveThreshold+CC+Tesseract.js)
- ✅ `src/lib/cv/changeDetection.ts` — 모듈 2 (4 메트릭 히스토그램 비교: CORREL/CHISQR/BHATTACHARYYA/INTERSECT)
- ✅ `src/lib/cv/frameMetrics.ts` — 모듈 3 (Laplacian variance + 밝기 통계)
- ✅ `src/hooks/useLiveFrameCapture.ts` — rAF 루프 (모듈 3 게이트 → 모듈 2 변화 감지 → 3프레임 연속)
- ✅ `src/hooks/useBiosPipeline.ts` — 모듈 1 훅
- ✅ `src/hooks/useGeminiLiveGuide.ts` — SSE 스트리밍
- ✅ `src/components/mobile/LiveGuideMode.tsx` — 메인 쇼케이스 컴포넌트
- ✅ 백엔드: `GuideController.java`, `LiveGuideService.java`

### Codex가 해야 할 것
각 모듈의 **Python 노트북** + **ablation 측정** + **그래프/CSV 산출**

## 핵심 파일

### 노트북 가이드 (읽고 따를 것)
- `notebooks/01-bios-pipeline.md` — 모듈 1 셀 구성 가이드
- `notebooks/02-histogram-analysis.md` — 모듈 2 셀 구성 가이드
- `notebooks/03-frame-quality.md` — 모듈 3 셀 구성 가이드
- `notebooks/requirements.txt` — Python 환경

### 이식된 파라미터 (노트북 결과로 업데이트 필요)
- `src/lib/cv/changeDetection.ts` 13번째 줄 `BEST_PARAMS` const
  - 현재: `{ metric: 'HISTCMP_CORREL', colorSpace: 'GRAY', windowSize: 3, threshold: 0.92 }`
  - 노트북 36조합 ablation 결과로 업데이트
- `src/lib/cv/biosPipeline.ts` 상단 const
  - `CLAHE_CLIP`, `CLAHE_GRID`, `ADAPT_BLOCK`, `ADAPT_C` — 노트북 그리드 서치 결과로 업데이트
- `src/lib/cv/frameMetrics.ts` `DEFAULT_OPTIONS`
  - `minSharpness: 0.18` — 노트북 임계값 튜닝 결과로 업데이트

## 다음 작업 (Codex)

- [ ] `notebooks/01-bios-pipeline.ipynb` 생성
  - BIOS 화면 이미지 로드 → 전처리 단계별 시각화
  - 단계 on/off 16조합 OCR 정확도 ablation
  - CLAHE 파라미터 그리드 서치
  - `docs/cv-pipeline/bios-pipeline-stages.png` 생성
  - `docs/ablation-results/bios-ablation.csv,png` 생성

- [ ] `notebooks/02-histogram-analysis.ipynb` 생성
  - 4 메트릭 × 3 컬러 × 3 윈도우 = 36조합 정확도 히트맵
  - 5개 시나리오 ROC 곡선
  - `docs/ablation-results/histogram-heatmap.png`, `histogram-roc.png` 생성
  - 베스트 파라미터 추출 → `src/lib/cv/changeDetection.ts` BEST_PARAMS 업데이트

- [ ] `notebooks/03-frame-quality.ipynb` 생성
  - Laplacian vs FFT vs Sobel 블러 검출 ROC
  - 임계값 그리드 서치 → Precision/Recall 트레이드오프
  - API 호출 절감 시뮬레이션
  - `docs/ablation-results/quality-roc.png`, `quality-tradeoff.png` 생성

## 주의사항

- **딥러닝 절대 금지** — 클래식 OpenCV + Tesseract.js inference만
- Python API와 OpenCV.js API 매핑 차이 주의 → `cv-workflow.md` 참조
  - Python: `dst = cv2.foo(src)` vs OpenCV.js: `cv.foo(src, dst)`
- Windows 한글 폰트: `plt.rcParams['font.family'] = 'Malgun Gothic'`
- 데이터셋: `data/bios/ground-truth.csv` 라벨링 필요 (사용자 본인 작업)
- 노트북 첫 셀에 출처 명시 필수 (카피 감점 -30 회피)

## 검증 방법
- `notebooks/01-bios-pipeline.ipynb` 전체 실행 → 마지막 셀에 OCR 정확도 표 출력
- `docs/ablation-results/*.png,*.csv` 파일 생성 확인
- `src/lib/cv/changeDetection.ts` BEST_PARAMS가 노트북 결과와 일치 확인
