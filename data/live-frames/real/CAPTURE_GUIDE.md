# 실측 BIOS 영상 촬영 가이드 (모듈 2 재튜닝)

## 목적
합성 데이터로 튜닝된 `BEST_PARAMS.threshold=0.9999`가 실제 카메라 노이즈/자동노출/손떨림 환경에서도 유효한지 검증.
실측에서 더 현실적인 임계값(보통 0.90~0.97)이 나올 가능성 높음.

## 준비물
- BIOS 진입 가능한 PC (재시작 후 Del/F2)
- 스마트폰 (후면 카메라)
- 받침대 또는 거치대 (있으면 더 좋음 — 손떨림 false positive 평가에는 손에 들고 찍어도 OK)

## 촬영 조건
| 항목 | 권장 |
|---|---|
| 거리 | 30~50cm (화면이 프레임의 60~80% 차지) |
| 각도 | 정면 ±15° 이내 |
| 조명 | 일반 실내 조명, 직접 반사 없게 |
| 해상도 | 1080p (4K는 처리 시간만 늘어남) |
| 프레임레이트 | 30fps |
| 길이 | 60~120초 (필수 ≥ 60초) |

## 촬영 시나리오 — 정적 구간과 변화 구간 섞기

**핵심**: 변화 시점(true positive)과 안정 구간(true negative)이 둘 다 있어야 평가 가능.
아래 흐름 권장 (시간 표시는 가이드, 정확히 맞출 필요 없음 — 촬영 후 측정):

```
0:00–0:10  BIOS Main 화면 정적 유지 (정지 → false positive 측정)
0:10       Boot 탭으로 전환
0:10–0:20  Boot 탭 정적 유지
0:20       Boot Option 팝업 열기 (Enter)
0:20–0:30  팝업 정적 유지
0:30       팝업 닫기 (ESC)
0:30–0:40  Boot 탭 정적 유지
0:40       Save & Exit 탭으로 전환
0:40–0:50  Save & Exit 정적 유지
0:50       Setup Defaults 확인 다이얼로그 열기 (F9 / Y)
0:50–0:60  다이얼로그 정적 유지
0:60       다이얼로그 닫기 → 종료 (ESC)
```

**최소 5번의 화면 전환 + 그 사이 5~10초씩 정적 구간**이면 충분.
손에 들고 촬영하면 자연스러운 손떨림 false positive도 함께 평가됨.

## 저장 위치

```
data/live-frames/real-<vendor>/<name>.mp4
```

예시:
- `data/live-frames/real-msi/msi-bios-tour.mp4`
- `data/live-frames/real-asus/asus-uefi-tour.mp4`

`real-`로 시작하는 폴더명을 권장 — 합성 데이터와 분리해서 ablation 돌릴 수 있도록.

## 라벨링 — 화면 전환 시점 기록

촬영 후 비디오를 재생하면서 **실제 화면이 바뀐 시점의 timestamp(초)**를 기록.
정확도 ±0.5초로 충분 (스크립트가 ±0.5초 윈도우로 매칭).

`data/live-frames/real/ground-truth.csv`에 한 행씩 추가:

```csv
video_filename,event_timestamp_sec,event_type,notes,scenario
real-msi/msi-bios-tour.mp4,10.4,screen-change,Boot tab click,real-msi
real-msi/msi-bios-tour.mp4,20.1,screen-change,Boot Option popup open,real-msi
real-msi/msi-bios-tour.mp4,30.5,screen-change,Popup close,real-msi
real-msi/msi-bios-tour.mp4,42.0,screen-change,Save&Exit tab,real-msi
real-msi/msi-bios-tour.mp4,52.3,screen-change,Setup Defaults dialog,real-msi
real-msi/msi-bios-tour.mp4,61.8,screen-change,Dialog close,real-msi
```

> VLC: 단축키 `e`로 한 프레임씩 진행 / `Ctrl+T`로 timestamp 점프.
> Windows 영화&TV 앱: 슬라이더 위에 마우스 올리면 timestamp 표시.

## 끝나면

다음과 같이 알려주세요:
- "촬영 끝 — `data/live-frames/real-msi/foo.mp4`에 1분 30초짜리 저장, ground-truth.csv에 6개 전환 라벨링 완료"

그러면 제가 `python notebooks/run_module2_real_ablation.py` 실행해서 결과 분석하고 README/changeDetection.ts 업데이트합니다.

## 추가 팁

- **여러 영상 권장**: 같은 PC라도 2~3개 짧은 영상이 한 개 긴 영상보다 평가 다양성 ↑
- **다른 vendor가 있으면 보너스**: MSI + ASUS 등 두 종류면 README의 BIOS vendor 일반화 주장이 강해짐
- **실패 케이스도 가치 있음**: 손이 떨려서 흔들리거나, 자동초점이 헷갈리는 영상도 false positive 데이터로 활용 가능 — 버리지 마세요
