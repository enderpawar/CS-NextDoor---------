import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticClipSummary,
  classifyDiagnosticClipMode,
  hasEnoughDiagnosticClipSamples,
  shouldStartDiagnosticClip,
} from './useDiagnosticClipCapture';

describe('useDiagnosticClipCapture helpers', () => {
  it('keeps sub-threshold pointer input on the photo capture path', () => {
    expect(shouldStartDiagnosticClip(649)).toBe(false);
    expect(shouldStartDiagnosticClip(650)).toBe(true);
  });

  it('requires enough sampled frames before using the clip path', () => {
    expect(hasEnoughDiagnosticClipSamples(2)).toBe(false);
    expect(hasEnoughDiagnosticClipSamples(3)).toBe(true);
  });

  it('summarizes video-only capture when microphone permission is unavailable', () => {
    const summary = buildDiagnosticClipSummary({
      durationMs: 1300,
      sampledFrames: 8,
      selectedFrames: 5,
      brightnessValues: [0.2, 0.72, 0.22, 0.7, 0.21, 0.69],
      sceneChangeScores: [0, 0.24, 0.22, 0.26, 0.23, 0.2],
      audioAvailable: false,
      audioSamples: [],
    });

    expect(summary).toContain('captureSource=clip');
    expect(summary).toContain('audioAvailable=false');
    expect(summary).toContain('audioPeakCount=0');
    expect(summary).toContain('ledBlinkLikely=true');
  });

  it('marks repeated audio peaks as likely noise or beep evidence', () => {
    const summary = buildDiagnosticClipSummary({
      durationMs: 1800,
      sampledFrames: 10,
      selectedFrames: 4,
      brightnessValues: [0.45, 0.46, 0.44, 0.45],
      sceneChangeScores: [0, 0.04, 0.03, 0.05],
      audioAvailable: true,
      audioSamples: [
        { atMs: 0, rms: 0.02, peak: 0.03 },
        { atMs: 250, rms: 0.08, peak: 0.3 },
        { atMs: 500, rms: 0.02, peak: 0.04 },
        { atMs: 750, rms: 0.09, peak: 0.32 },
      ],
    });

    expect(summary).toContain('audioAvailable=true');
    expect(summary).toContain('beepOrNoiseLikely=true');
  });

  it('classifies unusable video plus audio evidence as audio-only', () => {
    const result = classifyDiagnosticClipMode(0, {
      peakCount: 2,
      rmsMean: 0.09,
      beepOrNoiseLikely: true,
    });

    expect(result.mode).toBe('audio-only');
    expect(result.feedback).toContain('소리');
  });

  it('classifies usable video plus audio evidence as hybrid', () => {
    expect(classifyDiagnosticClipMode(2, {
      peakCount: 2,
      rmsMean: 0.09,
      beepOrNoiseLikely: true,
    }).mode).toBe('hybrid');
  });

  it('classifies captures without audio evidence as visual', () => {
    expect(classifyDiagnosticClipMode(2, {
      peakCount: 0,
      rmsMean: 0.01,
      beepOrNoiseLikely: false,
    }).mode).toBe('visual');
  });
});
