# Data — 테스트 데이터셋

> Git에 큰 바이너리는 올리지 않습니다. `.gitignore`로 이미지/영상/오디오 파일은 제외하고,
> **`ground-truth.csv`와 디렉토리 구조만 추적**합니다.

## 디렉토리 구조

```
data/
├── bios/                       ← 모듈 1 (BIOS 화면 파이프라인)
│   ├── ami/                    ← AMI BIOS 스크린샷·사진 (vendor별)
│   ├── award/
│   ├── phoenix/
│   ├── other/
│   └── ground-truth.csv        ← filename, vendor, angle, lighting, top_menu_text
├── motherboard/                ← 모듈 6 (선택: 부품/커패시터)
│   └── ground-truth.csv
├── beep/                       ← 모듈 4 (선택: 비프음)
│   ├── ami-1-long/             ← 패턴별 wav 파일
│   ├── ami-3-short/
│   ├── ...
│   └── ground-truth.csv        ← filename, pattern, source(yt/recorded)
└── live-frames/                ← 모듈 2, 3 (변화 감지, 품질 필터)
    ├── normal-change/          ← 시나리오별 영상
    ├── hand-shake/
    ├── lighting/
    ├── rolling-shutter/
    ├── ios-autofocus/
    ├── quality-mix/            ← 모듈 3 정지 사진 200장
    └── ground-truth.csv        ← timestamp 또는 quality label
```

## 수집 지침

### 웹 테스트 데이터
- `notebooks/fetch_commons_test_data.py`는 Wikimedia Commons의 라이선스 명시 파일을 내려받아 테스트 데이터로 배치합니다.
- 내려받은 이미지 바이너리는 `.gitignore`로 추적하지 않고, 출처/저자/라이선스는 `data/web-test-sources.csv`에 기록합니다.
- Commons rate limit이 걸릴 수 있으므로 스크립트는 이미 받은 파일을 보존하고 누락 파일만 재시도합니다.

### `data/bios/`
- **최소 수량**: vendor당 5장, 총 20~30장
- **다양성**: 각도(정면, 15°, 30°, 45°), 조명(밝음, 어두움), 거리
- **출처**: 본인 PC 직접 촬영 + YouTube BIOS 튜토리얼 화면 캡처
- **YouTube 사용 시**: README References에 URL + 채널명 명시 (카피 감점 회피)
- **ground-truth.csv 컬럼**: `filename,vendor,angle_deg,lighting,top_menu_text,notes`

### `data/live-frames/<scenario>/`
- **각 시나리오 영상 1~2개**, 30~60초 분량
- **수동 라벨링**: 영상 보면서 "실제 화면 전환 발생 시각"을 `ground-truth.csv`에 timestamp로 기록
- **컬럼**: `video_filename,event_timestamp_sec,event_type,notes`

### `data/live-frames/quality-mix/`
- 정상/블러/과노출/저조도/흔들림 비율 균등하게 ~200장
- 직접 촬영 가능 — 일부러 흔들거나 빛을 다르게
- **컬럼**: `filename,label(good/bad),defect_type(blur/over/under/shake/none)`

### `data/beep/<pattern>/`
- 비프음 사운드뱅크 사이트 + YouTube 추출
- 자체 합성도 가능 (numpy로 sine wave 생성)
- **컬럼**: `filename,pattern_code,source,duration_sec`

## .gitignore 규칙

`data/.gitignore`:

```
# Raw binaries (do not track)
*.jpg
*.jpeg
*.png
*.mp4
*.mov
*.avi
*.wav
*.mp3

# Track everything else
!ground-truth.csv
!README.md
!.gitkeep
```

## 라이선스 / 출처

- YouTube 캡처는 **공정 이용(연구 목적)** 범위에서만 사용
- README References 섹션에 각 영상의 URL + 채널명 명시
- 본인 촬영 사진은 라이선스 자유
