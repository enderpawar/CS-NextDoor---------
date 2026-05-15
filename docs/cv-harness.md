# CV Harness

This harness keeps the computer-vision pipeline testable before it is wired to
`CameraView`, `VideoAnalysis`, or OpenCV.js.

## Core module

- `src/lib/cv/frameMetrics.ts`
  - `analyzeFrame(frame, previousHistogram?, options?)`
  - `selectTopFrames(frames, limit, options?)`
  - `compareHistograms(a, b)`
  - `summarizeFrameSet(frames, options?)`

The input is an RGBA frame:

```ts
{
  id: 'frame-001',
  width: canvas.width,
  height: canvas.height,
  data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
}
```

## Metrics

- `brightnessMean`, `brightnessStdDev`: dark/overexposed frame rejection
- `laplacianVariance`, `sharpnessScore`: blur/stability rejection
- `edgeDensity`, `coverageRatio`: target/ROI coverage estimation
- `histogramSimilarity`, `sceneChangeScore`: duplicate-frame filtering
- `qualityScore`: ranking score for frame selection
- `guidance`: user-facing capture state

## Commands

```bash
npm run test:cv
npm run type-check
```

## Integration rule

Keep camera and OpenCV bindings thin. Browser components should capture image
data, call this harness, render metrics/overlays, and only send selected usable
frames to the diagnosis API.

Recommended Phase 7 flow:

```text
video frame
-> canvas ImageData
-> analyzeFrame()
-> render guidance + ROI/quality UI
-> selectTopFrames()
-> Gemini diagnosis request
```
