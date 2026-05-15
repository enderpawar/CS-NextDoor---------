# docs/ — 문서 디렉토리

| 파일/디렉토리 | 용도 |
|---|---|
| `cv-harness.md` | (기존) `src/lib/cv/frameMetrics.ts` 사용 가이드 |
| `snippets.md` | (기존) Phase별 구현 레퍼런스 — on-demand |
| `architecture.md` | 시스템 아키텍처 다이어그램 + 컴포넌트 설명 (README 임베드용) |
| `cv-pipeline/` | CV 알고리즘 파이프라인 단계별 시각화 PNG |
| `ablation-results/` | 정량 평가 결과 — CSV, PNG (모듈별) |

## README 빌드 시 사용 흐름

```
notebooks/*.ipynb 실행
  ↓ 산출물 저장
docs/cv-pipeline/*.png         ← 알고리즘 단계 갤러리
docs/ablation-results/*.png    ← 정량 비교 그래프
docs/ablation-results/*.csv    ← 정량 데이터
  ↓ 임베드
README.md ← 점수 결정의 60%
```
