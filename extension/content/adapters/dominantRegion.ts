/**
 * Platform-agnostic heuristic for picking the "shared content" video tile out
 * of a set of visible `<video>` elements, without depending on either
 * platform's internal DOM structure.
 *
 * Neither Google nor Microsoft publishes stable selectors or class names for
 * Meet's or Teams' presentation tile, and both redesign their DOM often
 * enough that hardcoding one would be confidently wrong within a few
 * releases -- worse than the honest "audio-only" fallback it would replace,
 * since a wrong region fails silently (captures garbage) instead of loudly.
 *
 * What's stable across both platforms instead: when someone shares content,
 * that tile becomes the dominant "main stage" element and camera tiles
 * shrink to a strip alongside it. When nobody is sharing, camera tiles stay
 * roughly uniform in size. So: find the video whose rendered area is a clear
 * outlier versus the rest. If there's no clear outlier -- including the
 * common "only one video visible" case, which is just as likely to be a lone
 * camera feed as a genuine share -- there is nothing to point at, and this
 * returns null (audio-only mode) rather than guessing.
 *
 * This is pure geometry over already-extracted rectangles specifically so it
 * is unit-testable without a DOM; the adapters (meet.ts / teams.ts) own the
 * one line of `document.querySelectorAll` + `getBoundingClientRect` that
 * feeds it.
 */

export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DominantRegionConfig {
  /** Tiles smaller than this (px^2) are ignored as thumbnails/hidden elements. */
  minAreaPx: number;
  /** The largest tile must be at least this many times the median of the rest to count as dominant. */
  dominanceRatio: number;
}

export const DEFAULT_DOMINANT_REGION_CONFIG: DominantRegionConfig = {
  minAreaPx: 40 * 40,
  dominanceRatio: 2.5,
};

export function pickDominantRegion(
  rects: VideoRect[],
  config: DominantRegionConfig = DEFAULT_DOMINANT_REGION_CONFIG,
): VideoRect | null {
  const candidates = rects.filter((r) => r.width * r.height >= config.minAreaPx);

  // Need at least one other tile to compare against -- a single visible
  // video is exactly as likely to be a lone camera feed as a genuine share,
  // and guessing wrong here means hashing someone's face as "content."
  if (candidates.length < 2) return null;

  const withArea = candidates.map((r) => ({ rect: r, area: r.width * r.height })).sort((a, b) => b.area - a.area);
  const [largest, ...rest] = withArea;
  const restMedian = median(rest.map((r) => r.area));

  if (restMedian === 0 || largest!.area < restMedian * config.dominanceRatio) return null;

  return largest!.rect;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Extracts visible-video geometry from the live document. Both platform
 * adapters use this identically -- the heuristic in `pickDominantRegion` is
 * what's platform-agnostic, not the DOM query itself, but there's no reason
 * for meet.ts and teams.ts to each reimplement "find visible video rects."
 * Not unit-tested directly (it's a thin DOM read with no branching logic of
 * its own); `pickDominantRegion`, which is where the actual decisions live,
 * is tested in dominantRegion.test.ts.
 */
export function visibleVideoRects(doc: Document = document): VideoRect[] {
  const videos = Array.from(doc.querySelectorAll('video'));
  const rects: VideoRect[] = [];
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (video.style.display === 'none' || video.style.visibility === 'hidden') continue;
    rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }
  return rects;
}
