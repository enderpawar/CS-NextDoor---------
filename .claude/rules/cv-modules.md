# CV 모듈 명세 — 컴퓨터 비전 텀프로젝트 평가 어필 코어

> **목적**: CV 과목 텀프로젝트 만점을 위한 클래식 OpenCV 알고리즘 모듈 명세.
> **딥러닝 학습 절대 금지** (사용자 결정). Tesseract.js는 사전 학습 모델 inference만 허용.
> 모든 알고리즘은 OpenCV-Python(Jupyter)에서 검증 후 OpenCV.js로 1:1 이식.

---

## 우선순위 요약

| 우선순위 | 모듈 | 위치 | 시간 | 필수 여부 |
|---|---|---|---|---|
| 🥇 P0 | 모듈 1 — BIOS 화면 End-to-End 파이프라인 | Phase 7-B | 3일 | **필수** |
| 🥈 P1 | 모듈 2 — 라이브 프레임 변화 감지 정량 분석 | Phase 7-B | 1.5일 | **필수** |
| 🥉 P2 | 모듈 3 — 프레임 품질 사전 필터 | Phase 7-B | 1.5일 | **필수** |
| 4 | 모듈 4 — 비프음 스펙트로그램 분석 | Phase 8 | 2~3일 | 선택 (시간 시) |
| 5 | 모듈 5 — 카메라 캘리브레이션 보정 | Phase 7-B 보강 | 1~2일 | 선택 |
| 6 | 모듈 6 — 부푼 커패시터 검출 (Hough Circle) | Phase 7 | 2~3일 | 선택 (데이터 확보 시) |
| 7 | 모듈 7 — 메인보드 이미지 스티칭 | Phase 7 | 1~2일 | 선택 |

**최소 합격 라인 (만점 진입 가능)**: 모듈 1+2+3 완성 + ablation 측정 + README 시각화 완비.

---

## 모듈 1 — BIOS 화면 End-to-End 파이프라인 🥇

### 책임
카메라에 비친 BIOS 화면을 정면화 + 대비 강화 + 이진화 + OCR하여 메뉴 항목을 추출.
**Phase 7-B 라이브 가이드의 핵심**.

### 파이프라인
```
원본 프레임 (RGBA Canvas ImageData)
 → cv.cvtColor(GRAY)
 → cv.Canny → cv.HoughLinesP → 4 모서리 후보
 → cv.findHomography + cv.warpPerspective → 정면화
 → cv.CLAHE(clipLimit=2.0, tileGridSize=(8,8))
 → cv.adaptiveThreshold(GAUSSIAN_C, blockSize=11, C=2)
 → cv.connectedComponentsWithStats → 텍스트 ROI 분리
 → Tesseract.js OCR (lang='eng', psm=6)
 → Levenshtein distance → BIOS 메뉴 사전 매칭
```

### 산출 데이터 (ablation)
1. 전처리 단계 on/off 16조합 × OCR 정확도
2. Threshold 방법 3종(Otsu/Gaussian/Mean) × 조명 조건
3. CLAHE 파라미터 그리드 서치 (clipLimit × tileSize)
4. 카메라 각도 0/15/30/45° 정확도

### 통합 위치
- 노트북: `notebooks/01-bios-pipeline.ipynb`
- 코드: `src/lib/cv/biosPipeline.ts` (신규)
- 훅: `src/hooks/useBiosPipeline.ts` (신규)
- 호출 지점: `src/components/mobile/LiveGuideMode.tsx` — Gemini 호출 직전 전처리

### 의존성
- OpenCV.js (PWA 이미 로드)
- `tesseract.js` (신규 npm 패키지)

### 학술 인용
- Hough (1962) / Pizer et al. (1987) / Otsu (1979) / Bradley & Roth (2007) / Smith (2007)

---

## 모듈 2 — 라이브 프레임 변화 감지 정량 분석 🥈

### 책임
Phase 7-B 라이브 가이드의 히스토그램 변화 감지 로직을 **정량 평가만 추가**.
구현은 이미 `snippets.md`의 `[Live Guide] 히스토그램 3프레임 연속 안정화`에 설계됨.

### 측정 매트릭스 (36조합)
- 메트릭: `HISTCMP_CORREL` / `CHISQR` / `BHATTACHARYYA` / `INTERSECT`
- 컬러 공간: RGB / HSV / Grayscale
- 안정화 윈도우: 1 / 3 / 5 프레임 연속

### 시나리오 5종
1. 정상 화면 전환
2. 손 떨림 (false positive 위험)
3. 조명 변화 (false positive 위험)
4. Rolling Shutter 아티팩트
5. iOS 자동 초점 변경

### 산출 데이터
1. 36조합 정확도 히트맵
2. 시나리오별 ROC 곡선
3. False Positive 사례 갤러리

### 통합 위치
- 노트북: `notebooks/02-histogram-analysis.ipynb`
- 코드: `src/hooks/useLiveFrameCapture.ts` — 결정된 최적 파라미터 const 반영
- 베스트 조합을 `src/lib/cv/changeDetection.ts`(신규)로 분리

### 학술 인용
- Swain & Ballard (1991) "Color Indexing"
- OpenCV `compareHist` 공식 문서

---

## 모듈 3 — 프레임 품질 사전 필터 🥉

### 책임
Gemini 호출 직전 품질 나쁜 프레임 거부 → **비용 절감 + 정확도 보존**.

### 사용 알고리즘
- **Laplacian Variance**: `cv.Laplacian(gray, CV_64F).var()` < T1 → 블러
- **FFT 고주파 비율**: 비교용 두 번째 방법 (검증용)
- **밝기 통계**: `cv.meanStdDev` → 극단값 거부
- **Optical Flow Magnitude**: `cv.calcOpticalFlowFarneback` → 흔들림 거부 (옵션)

### 산출 데이터
1. 단일 메트릭별 ROC (Laplacian vs FFT vs Sobel)
2. 결합 필터 임계값 튜닝 (Precision/Recall 트레이드오프)
3. **비용 절감 정량화**: 필터 통과율 × 호출 비용 = 절감액

### 통합 위치
- 노트북: `notebooks/03-frame-quality.ipynb`
- 코드: `src/lib/cv/frameMetrics.ts` (기존, 보강) — 결정된 임계값 const 반영
- 호출 지점: `src/hooks/useLiveFrameCapture.ts` — 히스토그램 비교 직전 게이트

### 학술 인용
- Pertuz et al. (2013) "Analysis of focus measure operators"
- Farnebäck (2003) "Two-Frame Motion Estimation"

---

## 모듈 4 — 비프음 스펙트로그램 분석 (선택)

### 책임
비프음 .wav → 멜 스펙트로그램(이미지) → 클래식 CV로 패턴 분류.
**"오디오를 비전 문제로 변환"** 어필 포인트.

### 파이프라인
```
.wav → librosa.feature.melspectrogram → 이미지
 → cv.adaptiveThreshold → 비프 영역 이진화
 → cv.connectedComponents → 개수/타이밍
 → cv.matchTemplate (cross-correlation) → 알려진 패턴 매칭
 → 결과: "RAM 오류 (3회 짧은 비프)"
```

### 산출 데이터
1. Template Matching vs DTW 정확도 비교
2. 노이즈 강건성 (SNR 30/20/10dB)
3. 패턴 분류 혼동행렬

### 통합 위치
- 노트북: `notebooks/04-beep-spectrogram.ipynb`
- 코드: `src/lib/cv/beepClassifier.ts` (신규)
- 훅: `src/hooks/useBeepClassifier.ts` (신규)
- 호출 지점: `src/components/mobile/AudioCapture.tsx`

---

## 모듈 5~7 — 시간 여유 시 추가

### 모듈 5: 카메라 캘리브레이션 (체커보드 → 렌즈 왜곡 보정)
- `cv.findChessboardCorners` + `cv.calibrateCamera` + `cv.undistort`
- 모듈 1 정면화 정확도 추가 향상

### 모듈 6: 부푼 커패시터 검출
- `cv.HoughCircles` + 상단 곡률 분석
- ⚠️ 데이터셋 확보 난이도 높음

### 모듈 7: 메인보드 이미지 스티칭
- `cv.ORB` + `cv.BFMatcher` + `cv.findHomography`
- 여러 각도 사진 → 전체 메인보드 뷰

---

## 모듈 추가 시 체크리스트

새 모듈을 만들 때:

- [ ] `notebooks/NN-<module>.md` 가이드 문서 + `NN-<module>.ipynb` 노트북
- [ ] `data/<category>/` 데이터셋 + `ground-truth.csv`
- [ ] `src/lib/cv/<module>.ts` OpenCV.js 이식
- [ ] `src/hooks/use<Module>.ts` React 훅
- [ ] 통합 컴포넌트 수정
- [ ] `docs/cv-pipeline/<module>-stages.png` 단계별 시각화
- [ ] `docs/ablation-results/<module>-*.{csv,png}` 정량 결과
- [ ] README에 섹션 추가 + 학술 인용

---

## 카피 감점 회피 (최대 -30점)

모든 모듈의 README 섹션 또는 코드 주석에 다음을 명시:

- OpenCV 함수 출처 (`cv2.HoughLinesP` → OpenCV docs URL)
- 알고리즘 원논문 (Hough 1962 등)
- 참고 튜토리얼 URL (PyImageSearch, OpenCV 공식)
- 사용 라이브러리 (Tesseract.js, librosa)
- 데이터셋 출처 (YouTube URL + 채널명)

`[[evaluation-metrics]]` 문서의 References 섹션 양식 참조.
