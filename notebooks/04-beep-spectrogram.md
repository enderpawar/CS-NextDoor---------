# 노트북 4 — 비프음 스펙트로그램 분석 (선택)

> ⚠️ Phase 8 미시작 상태. 시간 여유 있을 때만 진행.

## 목표
비프음 .wav → 멜 스펙트로그램(이미지) → 클래식 CV 알고리즘으로 패턴 분류.
"오디오 처리를 비전 문제로 변환" 어필 포인트.

## 입력 데이터
- `data/beep/<pattern>/*.wav`
  - `pattern ∈ {ami-1-long, ami-3-short, award-no-mem, phoenix-cpu-fail, ...}`
  - YouTube 추출 + 자체 녹음 + 합성

## 셀 구성

1. **셋업**: `librosa`, `soundfile`, `scipy.signal`
2. **wav 로딩 + 시각화**: 파형 + 일반 스펙트로그램 + 멜 스펙트로그램
3. **이진화**: `cv2.adaptiveThreshold`로 비프 영역 추출
4. **Connected Components**: 비프 개수/타이밍 추출
5. **Template Matching**
   - `cv2.matchTemplate`으로 알려진 패턴과 비교
   - vs DTW(`dtw-python`) — 시간축 유연성 비교
6. **노이즈 강건성**: SNR 30/20/10dB 추가 후 정확도 측정
7. **시각화 저장**
   - 패턴별 스펙트로그램 갤러리 → `docs/cv-pipeline/beep-spectrograms.png`
   - 방법별 정확도 → `docs/ablation-results/beep-methods-comparison.png`
   - 노이즈 강건성 그래프 → `docs/ablation-results/beep-noise-robustness.png`

## 통합 위치
- `src/components/mobile/AudioCapture.tsx` + 새 훅 `useBeepClassifier.ts`
- 또는 백엔드(Spring)로 .wav 보내 Python 마이크로서비스로 분류

## 참고 문헌
- Brown et al. (1991). "Calculation of a constant Q spectral transform" (멜 스케일)
- Müller, M. (2007). "Information Retrieval for Music and Motion" (DTW)
