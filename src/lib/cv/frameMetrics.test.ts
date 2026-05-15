import { describe, expect, it } from 'vitest';
import type { CvFrameInput } from '../../types';
import { analyzeFrame, compareHistograms, selectTopFrames, summarizeFrameSet } from './frameMetrics';

function makeFrame(
  id: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): CvFrameInput {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { id, width, height, data };
}

const solidFrame = (id: string, value: number): CvFrameInput =>
  makeFrame(id, 48, 48, () => [value, value, value]);

const checkerFrame = (id: string): CvFrameInput =>
  makeFrame(id, 48, 48, (x, y) => {
    const value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 32 : 224;
    return [value, value, value];
  });

const squareFrame = (id: string, squareSize: number): CvFrameInput =>
  makeFrame(id, 48, 48, (x, y) => {
    const start = Math.floor((48 - squareSize) / 2);
    const end = start + squareSize;
    const inside = x >= start && x < end && y >= start && y < end;
    return inside ? [220, 220, 220] : [34, 34, 34];
  });

describe('CV frame metrics harness', () => {
  it('classifies dark frames before using them for diagnosis', () => {
    const metrics = analyzeFrame(solidFrame('dark', 8));
    expect(metrics.guidance).toBe('too_dark');
    expect(metrics.isUsable).toBe(false);
    expect(metrics.brightnessMean).toBeLessThan(0.05);
  });

  it('classifies flat blurred frames as stabilize', () => {
    const metrics = analyzeFrame(solidFrame('flat', 128));
    expect(metrics.guidance).toBe('stabilize');
    expect(metrics.sharpnessScore).toBe(0);
    expect(metrics.isUsable).toBe(false);
  });

  it('detects usable high-frequency frames with broad coverage', () => {
    const metrics = analyzeFrame(checkerFrame('checker'));
    expect(metrics.guidance).toBe('ready');
    expect(metrics.isUsable).toBe(true);
    expect(metrics.sharpnessScore).toBeGreaterThan(0.8);
    expect(metrics.coverageRatio).toBeGreaterThan(0.8);
    expect(metrics.qualityScore).toBeGreaterThan(75);
  });

  it('rejects small target regions as too far', () => {
    const metrics = analyzeFrame(squareFrame('tiny-roi', 4), undefined, {
      minCoverageRatio: 0.04,
    });
    expect(metrics.guidance).toBe('too_far');
    expect(metrics.coverageRatio).toBeLessThan(0.04);
  });

  it('compares grayscale histograms for duplicate-frame filtering', () => {
    const first = analyzeFrame(checkerFrame('a'));
    const duplicate = analyzeFrame(checkerFrame('b'));
    const different = analyzeFrame(solidFrame('white', 240));

    expect(compareHistograms(first.histogram, duplicate.histogram)).toBeCloseTo(1, 5);
    expect(compareHistograms(first.histogram, different.histogram)).toBeLessThan(0.1);
  });

  it('selects only the best usable frames by quality score', () => {
    const frames = [
      solidFrame('dark', 4),
      squareFrame('tiny', 4),
      checkerFrame('best'),
      squareFrame('usable-square', 24),
    ];

    const selected = selectTopFrames(frames, 2);
    expect(selected).toHaveLength(2);
    expect(selected[0]!.frame.id).toBe('best');
    expect(selected.every(candidate => candidate.metrics.isUsable)).toBe(true);
  });

  it('summarizes fixture sets for reportable CV metrics', () => {
    const summary = summarizeFrameSet([
      solidFrame('dark', 4),
      solidFrame('flat', 128),
      checkerFrame('good'),
      squareFrame('roi', 28),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.usable).toBe(2);
    expect(summary.rejected).toBe(2);
    expect(summary.avgQuality).toBeGreaterThan(20);
  });
});
