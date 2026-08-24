/**
 * Synthesizes deterministic audio/video for the fake-Meet harness entirely
 * in-page -- no binary fixture files to check into the repo, matching the
 * pattern used for the unit-level frame fixtures in
 * tests/fixtures/synthFrame.ts. `canvas.captureStream()` gives the
 * presentation and camera tiles real MediaStreamTracks, and a WebAudio
 * oscillator connected to the destination gives the tab a real audio track
 * -- both of which chrome.tabCapture needs something genuine to capture,
 * not just a static image.
 *
 * `window.__harness` is the control surface a Playwright test drives via
 * `page.evaluate()`.
 */

const statusEl = document.getElementById('status');

function setupPresentation() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  let slideIndex = 1;

  function draw() {
    // Gradient background + a block, similar in spirit to the pHash unit
    // tests' slideFrame fixture -- real 2D structure, not a flat color, so
    // the same diffing code path that runs against real content runs here.
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#1a1a2e');
    gradient.addColorStop(1, '#16213e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#e94560';
    ctx.fillRect(80, 100, 400, 60);

    ctx.fillStyle = '#ffffff';
    ctx.font = '64px sans-serif';
    ctx.fillText(`Slide ${slideIndex}`, 80, 300);

    ctx.fillStyle = '#0f766e';
    ctx.fillRect(80, 400 + slideIndex * 5, 300, 40);
  }

  draw();
  // 2fps matches the real sampler's SAMPLE_INTERVAL_MS -- driving the canvas
  // at the same rate the extension samples at is what makes this a
  // meaningful capture-rate stand-in rather than an arbitrary one.
  const stream = canvas.captureStream(2);
  document.querySelector('[data-testid="presentation"]').srcObject = stream;

  return {
    setSlide(n) {
      slideIndex = n;
      draw();
      // captureStream's track only emits a new frame when the canvas
      // actually repaints between capture ticks, which draw() above does --
      // no manual "request a frame" call needed.
    },
    getSlide() {
      return slideIndex;
    },
  };
}

function setupCamera(selector, hue) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');

  let t = 0;
  function draw() {
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // A small moving dot -- stands in for a person shifting slightly on
    // camera, exactly the kind of motion the region heuristic and the
    // debounce logic both need to NOT treat as "shared content changed."
    const x = canvas.width / 2 + Math.sin(t / 20) * 20;
    ctx.fillStyle = `hsl(${hue}, 60%, 55%)`;
    ctx.beginPath();
    ctx.arc(x, canvas.height / 2, 30, 0, Math.PI * 2);
    ctx.fill();
    t++;
  }

  draw();
  setInterval(draw, 1000 / 15);
  const stream = canvas.captureStream(15);
  document.querySelector(selector).srcObject = stream;
}

function setupAudio() {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  // Low, quiet, and varying -- present enough for tabCapture to have a real
  // signal, quiet enough not to be obnoxious in a headed test run.
  gain.gain.value = 0.02;
  oscillator.frequency.value = 220;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();

  let t = 0;
  setInterval(() => {
    t += 0.1;
    oscillator.frequency.value = 220 + Math.sin(t) * 40;
  }, 200);

  return context;
}

const presentation = setupPresentation();
setupCamera('[data-testid="cam-1"]', 20);
setupCamera('[data-testid="cam-2"]', 200);
const audioContext = setupAudio();

window.__harness = {
  setSlide: presentation.setSlide,
  getSlide: presentation.getSlide,
  resumeAudio: () => audioContext.resume(),
};

statusEl.textContent = 'ready';
