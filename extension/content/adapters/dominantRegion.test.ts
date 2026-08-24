import { describe, it, expect } from 'vitest';
import { pickDominantRegion, type VideoRect } from './dominantRegion';

function rect(x: number, y: number, width: number, height: number): VideoRect {
  return { x, y, width, height };
}

describe('pickDominantRegion', () => {
  it('returns null when there is only one visible video (could be a lone camera, not a share)', () => {
    expect(pickDominantRegion([rect(0, 0, 1280, 720)])).toBeNull();
  });

  it('returns null when there are no videos at all', () => {
    expect(pickDominantRegion([])).toBeNull();
  });

  it('returns null for a gallery of roughly equal-size camera tiles (nobody sharing)', () => {
    const tiles = [rect(0, 0, 300, 200), rect(300, 0, 300, 200), rect(0, 200, 300, 200), rect(300, 200, 300, 200)];
    expect(pickDominantRegion(tiles)).toBeNull();
  });

  it('identifies a clear main-stage tile among shrunk camera tiles as the shared content', () => {
    const mainStage = rect(0, 0, 1280, 720);
    const camStrip = [rect(1280, 0, 160, 90), rect(1280, 90, 160, 90)];
    const result = pickDominantRegion([mainStage, ...camStrip]);
    expect(result).toEqual(mainStage);
  });

  it('filters out tiny/hidden thumbnail elements before comparing', () => {
    const mainStage = rect(0, 0, 1280, 720);
    const tinyHidden = rect(0, 0, 1, 1); // e.g. a display:none video still in the DOM
    const camStrip = rect(1280, 0, 160, 90);
    const result = pickDominantRegion([mainStage, tinyHidden, camStrip]);
    expect(result).toEqual(mainStage);
  });

  it('requires the dominance ratio to be met, not just "largest of the group"', () => {
    // Largest is only ~1.5x the other -- not a strong enough signal to call it a share.
    const a = rect(0, 0, 400, 300);
    const b = rect(400, 0, 320, 260);
    expect(pickDominantRegion([a, b])).toBeNull();
  });

  it('uses the median of the remaining tiles, not just the second-largest, to resist one outlier camera tile', () => {
    // One presentation tile, one slightly-larger-than-typical camera tile,
    // and several typical small camera tiles. Median of the rest should
    // still be dominated by the typical tiles, not skewed by the one outlier.
    const mainStage = rect(0, 0, 1280, 720);
    const rest = [rect(1280, 0, 300, 200), rect(1280, 200, 100, 80), rect(1280, 280, 100, 80), rect(1280, 360, 100, 80)];
    const result = pickDominantRegion([mainStage, ...rest]);
    expect(result).toEqual(mainStage);
  });

  it('respects a custom config', () => {
    const a = rect(0, 0, 200, 200);
    const b = rect(200, 0, 190, 190);
    // Default dominanceRatio (2.5) would reject this; a lenient config accepts it.
    expect(pickDominantRegion([a, b], { minAreaPx: 100, dominanceRatio: 1.05 })).toEqual(a);
  });

  it('excludes all-tiny videos even if one is relatively dominant among them', () => {
    const tiny1 = rect(0, 0, 10, 10);
    const tiny2 = rect(20, 0, 5, 5);
    expect(pickDominantRegion([tiny1, tiny2])).toBeNull();
  });
});
