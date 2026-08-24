/**
 * Platform adapter contract. Meet and Teams DOM specifics are quarantined
 * behind this interface (one file each, see meet.ts / teams.ts) so a
 * platform redesign breaks one adapter, not the capture pipeline. Expect
 * these to break on redesigns -- they are designed to fail loudly (report
 * `null`, i.e. "no shared content found," rather than guess) rather than
 * silently.
 *
 * Real region-detection logic lands in M2. For M1 both adapters report "no
 * region" unconditionally, which is a legitimate state (FR: audio-only mode)
 * and keeps the content script's message contract exercised end-to-end
 * before the DOM-specific work begins.
 */

export interface PresentationRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlatformAdapter {
  readonly platform: 'meet' | 'teams';
  /** True if the current page matches this adapter's platform. */
  matches(url: string): boolean;
  /**
   * Locates the shared-content element's bounding box in viewport
   * coordinates, or null if nothing is currently being shared (audio-only
   * mode). Called on a polling interval by the content script, not once --
   * shares start, stop, and switch presenters during a meeting.
   */
  findPresentationRegion(): PresentationRegion | null;
}
