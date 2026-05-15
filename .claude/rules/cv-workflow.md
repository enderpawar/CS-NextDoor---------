# CV 작업 흐름 — Python 실험 → OpenCV.js 이식

> **원칙**: 알고리즘 검증·튜닝·정량 측정은 **OpenCV-Python (Jupyter)** 에서,
> 런타임 통합은 **OpenCV.js (브라우저)** 로 이식한다.
> 이 분리가 30점 진입의 핵심 작업 흐름.

---

## 왜 이렇게 하는가

| 환경 | 장점 | 한계 |
|---|---|---|
| **OpenCV-Python (Jupyter)** | 즉시 반복, 풍부한 시각화(matplotlib/seaborn), 강건한 디버깅 | 브라우저 실행 불가 |
| **OpenCV.js (브라우저)** | PWA 런타임에서 동작 | 디버깅 빈약, 타입 정의 없음, Mat 메모리 수동 관리 |

**작업 흐름**:
1. Python에서 알고리즘 설계 + 파라미터 튜닝 + ablation 측정
2. README용 그래프/표는 모두 Python에서 생성 → `docs/cv-pipeline/`, `docs/ablation-results/`
3. 검증된 파이프라인을 OpenCV.js로 1:1 이식 → `src/lib/cv/`
4. 샘플 1~2개로 결과 일치 확인

---

## API 매핑 표 — Python ↔ OpenCV.js

OpenCV.js의 가장 큰 차이: **출력을 인자로 받음** (Python은 반환).

| Python | OpenCV.js |
|---|---|
| `gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)` | `cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY)` |
| `edges = cv2.Canny(gray, 50, 150)` | `cv.Canny(src, dst, 50, 150)` |
| `lines = cv2.HoughLinesP(edges, 1, np.pi/180, 100, 50, 10)` | `cv.HoughLinesP(edges, lines, 1, Math.PI/180, 100, 50, 10)` |
| `M, _ = cv2.findHomography(src, dst)` | `const M = cv.findHomography(srcMat, dstMat)` |
| `warped = cv2.warpPerspective(img, M, (w,h))` | `cv.warpPerspective(src, dst, M, new cv.Size(w,h))` |
| `clahe = cv2.createCLAHE(2.0, (8,8))` | `const clahe = new cv.CLAHE(2.0, new cv.Size(8,8))` |
| `out = clahe.apply(gray)` | `clahe.apply(src, dst)` |
| `_, bin = cv2.threshold(g, 0, 255, cv2.THRESH_OTSU)` | `cv.threshold(src, dst, 0, 255, cv.THRESH_OTSU)` |
| `cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)` | `cv.adaptiveThreshold(src, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2)` |
| `n, lbl, stats, _ = cv2.connectedComponentsWithStats(bin)` | `cv.connectedComponentsWithStats(src, labels, stats, centroids)` |
| `hist = cv2.calcHist([img],[0],None,[256],[0,256])` | `cv.calcHist(matVector, [0], mask, hist, sizes, ranges)` |
| `s = cv2.compareHist(h1, h2, cv2.HISTCMP_CORREL)` | `const s = cv.compareHist(h1, h2, cv.HISTCMP_CORREL)` |
| `lap = cv2.Laplacian(g, cv2.CV_64F).var()` | `cv.Laplacian(src, dst, cv.CV_64F); cv.meanStdDev(dst, mean, std); /* var = std**2 */` |
| `flow = cv2.calcOpticalFlowFarneback(p, c, None, ...)` | `cv.calcOpticalFlowFarneback(prev, next, flow, 0.5, 3, 15, 3, 5, 1.2, 0)` |

---

## Mat 메모리 관리 — OpenCV.js 필수 패턴

JS GC는 WASM 힙을 회수하지 못함. **모든 Mat은 try/finally로 `.delete()` 보장**.

```ts
// ❌ 누수
function processFrame(img: cv.Mat) {
  const gray = new cv.Mat();
  cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
  // 예외 시 gray 미해제 → 누수 누적
  doSomething(gray);
  gray.delete();
}

// ✅ 안전
function processFrame(img: cv.Mat) {
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();
  try {
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 50, 150);
    cv.HoughLinesP(edges, lines, 1, Math.PI/180, 100, 50, 10);
    return extractCorners(lines);
  } finally {
    [gray, edges, lines].forEach(m => m.delete());
  }
}
```

**`useRef`로 재사용하는 Mat**: 언마운트 시 `.delete()` 필수. `snippets.md` 참고.

---

## 노트북 → 코드 이식 체크리스트

새 모듈을 이식할 때:

- [ ] Python 노트북에서 **최종 파라미터 const로 추출** (예: `CLAHE_CLIP=2.0`, `THRESHOLD_BLOCK=11`)
- [ ] 1:1 매핑 표 따라 코드 작성 — `src/lib/cv/<module>.ts`
- [ ] 모든 Mat은 `try/finally + .delete()`
- [ ] React 훅 래핑 — `src/hooks/use<Module>.ts`
  - `useEffect` cleanup에서 `useRef`로 보관한 Mat 해제
  - `Strict Mode` 2회 호출 대비 (`isMounted` 패턴 또는 `useRef` 가드)
- [ ] **샘플 검증**: Python 결과 vs OpenCV.js 결과 1~2개 비교
- [ ] TypeScript: OpenCV.js 타입 정의 없음 → `declare const cv: any` 사용 + ESLint disable 주석
- [ ] 테스트 추가: 합성 입력으로 결정론적 결과 확인 (`src/lib/cv/__tests__/`)
- [ ] 통합 컴포넌트에서 호출

---

## Python 환경

`notebooks/requirements.txt` 참조. 핵심:

- `opencv-python>=4.9` — OpenCV.js와 동일 4.x 계열
- `pytesseract` + 시스템에 Tesseract 설치 (Windows: https://github.com/UB-Mannheim/tesseract/wiki)
- `matplotlib`, `seaborn`, `pandas`, `scikit-learn` — 시각화/평가
- `librosa`, `soundfile` — 모듈 4 비프음

**Windows 한글 폰트 깨짐 방지**:
```python
plt.rcParams['font.family'] = 'Pretendard'   # 또는 'Malgun Gothic'
plt.rcParams['axes.unicode_minus'] = False
```

---

## 디버깅 팁

### Python (Jupyter)
- 매 셀에서 `plt.imshow` 또는 `cv2_imshow` (Colab)로 중간 결과 확인
- `pandas.DataFrame`으로 ablation 결과 즉시 표로 보기

### OpenCV.js (브라우저)
- **중간 결과를 canvas에 그려서 시각화**:
  ```ts
  cv.imshow('debug-canvas', mat);   // <canvas id="debug-canvas"> 필요
  ```
- 개발자 도구 콘솔에서 `mat.rows`, `mat.cols`, `mat.type()` 확인
- `mat.data` 또는 `mat.data8U`로 픽셀 직접 접근 가능

---

## 알려진 OpenCV.js 함정

1. **출력 Mat 인자 패턴**: Python `dst = cv2.foo(src)` ≠ OpenCV.js `cv.foo(src, dst)`
2. **`cv.imread()`**: HTMLImageElement 또는 canvas만 받음. Mat 직접 못 만듦
3. **`Strict Mode` useEffect 2회 실행**: WASM 초기화 또는 listener 중복 등록 주의 (`snippets.md` 참고)
4. **WASM 초기화 비동기**: `cv.onRuntimeInitialized` 콜백 전까지 `cv.Mat()` 사용 금지
5. **타입 부재**: `declare const cv: any` + ESLint disable 사용. `coding-conventions.md` 참고
6. **모바일 성능**: rAF 루프 안에서 Mat 생성/해제 반복 시 GC 압박 → `useRef`로 재사용
7. **`HoughLinesP` 결과**: Mat이 행벡터 — `lines.data32S` 또는 `lines.intPtr(0, i)`로 접근

---

## 산출물 정리 규칙

| 종류 | 위치 |
|---|---|
| 노트북 | `notebooks/NN-<module>.ipynb` |
| 노트북 가이드 (셀 구성 설명) | `notebooks/NN-<module>.md` |
| 단계별 시각 갤러리 PNG | `docs/cv-pipeline/<module>-*.png` |
| Ablation 그래프 PNG | `docs/ablation-results/<module>-*.png` |
| Ablation raw CSV | `docs/ablation-results/<module>-*.csv` |
| OpenCV.js 알고리즘 | `src/lib/cv/<module>.ts` |
| React 훅 | `src/hooks/use<Module>.ts` |
| 단위 테스트 | `src/lib/cv/__tests__/<module>.test.ts` |
