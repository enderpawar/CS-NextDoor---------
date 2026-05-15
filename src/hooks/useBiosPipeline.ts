import { useRef, useCallback } from 'react';
import { runBiosPipeline } from '../lib/cv/biosPipeline';
import type { BiosPipelineResult } from '../lib/cv/biosPipeline';

export function useBiosPipeline() {
  const isRunningRef = useRef(false);

  const analyze = useCallback(
    async (canvas: HTMLCanvasElement): Promise<BiosPipelineResult | null> => {
      if (isRunningRef.current) return null;
      isRunningRef.current = true;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return await runBiosPipeline(rgba);
      } finally {
        isRunningRef.current = false;
      }
    },
    [],
  );

  return { analyze };
}
