# 평가 지표 및 README 작성 양식

> **목적**: CV 텀프로젝트 평가에서 점수의 60%는 README 품질이 결정.
> 정량 지표 / 시각 자료 / 학술 인용을 통일된 양식으로 관리한다.

---

## 최종 README 필수 섹션 체크리스트

```
□ 🎬 Demo (30~60초 GIF/영상)
□ 🎯 프로젝트 소개 (한 줄 요약 + 문제 정의 + 솔루션)
□ 🏗️ 시스템 아키텍처 (mermaid 다이어그램)
□ 🔬 컴퓨터 비전 파이프라인
    □ 모듈 1 — BIOS 화면 분석
        □ 알고리즘 다이어그램
        □ 단계별 시각 갤러리 (입력 → CLAHE → Threshold → OCR)
        □ Ablation Study 표
        □ 알고리즘 선택 근거 (왜 Gaussian vs Otsu)
    □ 모듈 2 — 라이브 변화 감지 (동일 구조)
    □ 모듈 3 — 프레임 품질 필터 (동일 구조)
    □ (선택) 모듈 4 — 비프음 스펙트로그램
□ 📊 정량 평가 (표 3개 이상 + 그래프 5개 이상)
□ ⚠️ 한계 및 Future Work
□ 🛠️ 설치 및 실행
□ 📚 References (URL 10개 이상)
□ 📜 License (MIT or Apache 2.0)
□ 👥 Contributors
```

---

## 정량 지표 선택 가이드

| 작업 종류 | 필수 지표 | 선택 지표 |
|---|---|---|
| **분류 (good/bad, vendor 등)** | Precision, Recall, F1 | ROC AUC, Confusion Matrix |
| **이진 분류 임계값 튜닝** | Precision-Recall 곡선 | ROC + 최적점 표시 |
| **변화 감지 / 이상치 탐지** | TPR vs FPR (ROC) | F1 vs Threshold |
| **OCR / 텍스트 추출** | Character Error Rate (CER), Levenshtein 유사도 ≥ 0.8 비율 | Word Error Rate (WER) |
| **시간성 작업** | 평균 추론 시간(ms), p95 latency | 메모리 사용량 |
| **비용 정량화** | API 호출 절감률(%), 추정 비용 절감액 | 통과율 vs 손실률 |

---

## 표 양식 — README 임베드용

### 1. Ablation Study 표 (단계 기여도)

```markdown
| 단계 조합 | OCR 정확도 | Δ vs baseline |
|---|---|---|
| 원본만 | 47.3% | — |
| + Homography (정면화) | 53.1% | +5.8%p |
| + Homography + CLAHE | 62.8% | +15.5%p |
| + Homography + CLAHE + Adaptive Threshold | 81.4% | +34.1%p |
| **전체 파이프라인 (+ Connected Components)** | **89.2%** | **+41.9%p** |
```

### 2. 알고리즘 비교 표

```markdown
| Threshold 방법 | 균일 조명 정확도 | 불균일 조명 정확도 | 추론 시간 |
|---|---|---|---|
| Otsu | 91.2% | 67.4% | 1.2ms |
| Adaptive Gaussian | 88.7% | **89.1%** | 3.8ms |
| Adaptive Mean | 86.4% | 84.2% | 3.5ms |
```

### 3. 시나리오별 정확도 표

```markdown
| 시나리오 | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| 정상 변화 | 47 | 2 | 3 | 0.959 | 0.940 | 0.949 |
| 손 떨림 | 0 | 1 | 0 | — | — | — |
| 조명 변화 | 0 | 3 | 0 | — | — | — |
| Rolling Shutter | 0 | 2 | 0 | — | — | — |
| iOS 자동초점 | 0 | 1 | 0 | — | — | — |
| **합계** | **47** | **9** | **3** | **0.839** | **0.940** | **0.887** |
```

---

## 그래프 양식 — matplotlib 권장 스타일

### 공통 설정
```python
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="whitegrid", context="paper", font_scale=1.2)
plt.rcParams['font.family'] = 'Pretendard'   # 한글 깨짐 방지
plt.rcParams['axes.unicode_minus'] = False
```

### 저장 양식
```python
plt.savefig('docs/ablation-results/<module>-<chart>.png',
            dpi=150, bbox_inches='tight', facecolor='white')
```

### 권장 차트 종류

| 데이터 | 차트 | 비고 |
|---|---|---|
| 임계값 vs 정확도 | `plt.plot` (선) | 최적점 별표 마킹 |
| 분류 결과 비율 | `sns.barplot` | Confusion matrix 대안 |
| 36조합 정확도 | `sns.heatmap` | annot=True, fmt='.2f' |
| Precision-Recall / ROC | `plt.plot` + `auc` 표시 | 시나리오별 색상 |
| 단계별 갤러리 | `plt.subplots(1, N)` | 각 셀에 axis off + title |

---

## 알고리즘 선택 근거 작성 양식

평가자가 "왜 이 알고리즘?"이라고 물었을 때 답이 되어야 함.

```markdown
### 알고리즘 선택 근거 — Threshold 방법

| 후보 | 장점 | 단점 | 본 프로젝트 적합성 |
|---|---|---|---|
| Otsu | 빠름, 자동 임계값 | 조명 불균일에 약함 | ❌ BIOS 화면 비스듬히 비추면 한쪽 그늘짐 |
| Adaptive Gaussian | 국소 적응 | 약간 느림 | ✅ 카메라 각도 변화에도 강건 |
| Adaptive Mean | 국소 적응, 매우 빠름 | Gaussian보다 노이즈 민감 | △ 텍스트 가장자리에서 손실 |

**결정**: Adaptive Gaussian Threshold.
- 측정 결과 불균일 조명 시 Otsu 67.4% vs Gaussian 89.1% (모듈 1 ablation 표 참조)
- 추가 비용은 Otsu 1.2ms → Gaussian 3.8ms (실시간 30fps 기준 충분)
```

---

## 한계 및 Future Work 양식

**솔직한 약점 인정이 오히려 점수**를 얻는다.

```markdown
## ⚠️ 한계 및 Future Work

### 현재 한계
1. **극단 조명**: 직사광 또는 매우 어두운 환경에서 OCR 정확도 50% 미만
   - 원인: CLAHE clipLimit 4.0으로도 보상 한계
   - 사례: [docs/cv-pipeline/quality-rejected-samples.png](...) 마지막 2장
2. **비표준 BIOS 화면**: AMI/Award/Phoenix 외 UEFI GUI는 메뉴 매칭 사전 미포함
3. **카메라 50° 이상 각도**: Hough Line 모서리 검출 실패율 30%
4. **OpenCV.js vs Python 미세 차이**: `HoughLinesP` 결과가 환경에 따라 1~2개 라인 차이 (실용상 무의미하지만 명시)

### Future Work
- 모듈 1: 코너 검출 robust화 — RANSAC 기반 4점 정제
- 모듈 4 완성 — 비프음 멜 스펙트로그램 분류 (현재 노트북만 작성)
- Phase 9~11: MCP 매뉴얼 툴, DB 이력, 세션 인증 (CV 무관 — 본 프로젝트 스코프 밖)
```

---

## References 양식 (카피 감점 회피, 최대 -30점 방지)

```markdown
## 📚 References

### 알고리즘
- Hough, P. V. C. (1962). *Method and Means for Recognizing Complex Patterns*. US Patent 3,069,654.
- Pizer et al. (1987). *Adaptive histogram equalization and its variations*. CVGIP 39(3).
- Otsu, N. (1979). *A threshold selection method from gray-level histograms*. IEEE TSMC 9(1).
- Bradley & Roth (2007). *Adaptive Thresholding using the Integral Image*. JGT 12(2).
- Smith, R. (2007). *An Overview of the Tesseract OCR Engine*. ICDAR.
- Farnebäck, G. (2003). *Two-Frame Motion Estimation Based on Polynomial Expansion*. SCIA.

### 라이브러리
- OpenCV 4.9 — https://opencv.org (BSD License)
- OpenCV.js — https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html
- Tesseract.js — https://github.com/naptha/tesseract.js (Apache 2.0)
- React 18 / Electron 28 / Spring Boot 3.x

### 참고 자료
- PyImageSearch — Adaptive Thresholding 튜토리얼 (URL)
- OpenCV docs — `cv::compareHist` (URL)
- (YouTube 캡처 사용 시) 영상 제목 + 채널명 + URL 명시

### 외부 API
- Google Gemini 3.1 Pro Vision API
```

---

## Demo 영상 작성 가이드

| 항목 | 사양 |
|---|---|
| 길이 | 30~60초 |
| 해상도 | 1080p 권장 |
| 형식 | mp4 + 5~10초 GIF (README 임베드) |
| 자막 | 한국어 (또는 한/영 병기) |
| 도구 | OBS Studio (녹화), ScreenToGif (변환), DaVinci Resolve (편집) |

### 권장 구성 (60초)

1. 0~5초: 프로젝트 한 줄 소개 + 메인 화면
2. 5~20초: 라이브 가이드 모드 실연 (카메라 → BIOS 안내)
3. 20~35초: CV 파이프라인 시각화 (split screen — 원본 vs 처리 결과)
4. 35~50초: SW 진단 흐름 (Electron 화면)
5. 50~60초: ablation 결과 그래프 + 마무리

---

## 평가 점수 시뮬레이션

| 시나리오 | 예상 점수 |
|---|---|
| 모듈 1만 완성 (ablation 미흡) | 24~26점 |
| 모듈 1 + 2 완성 + ablation | 26~28점 |
| **모듈 1 + 2 + 3 + 우수 README + demo** | **28~30점** ← 만점 진입 |
| + 모듈 4 추가 | 30점 확률 추가 상승 |

상대평가이므로 100% 보장 없음. README 품질이 결정적 변수.
