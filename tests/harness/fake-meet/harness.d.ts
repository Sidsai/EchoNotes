/** Ambient type for the fake-Meet harness's control surface, used from Playwright's page.evaluate(). */
export {};
declare global {
  interface Window {
    __harness: {
      setSlide(n: number): void;
      getSlide(): number;
      resumeAudio(): Promise<void>;
    };
  }
}
