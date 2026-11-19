/**
 * Loads assets/sprites/manifest.json and decodes every frame up front.
 *
 * All frames share one 256px canvas with a common ground line, so a clip change
 * never needs per-frame offsets: blit the whole square and the cat lands in the
 * right place.
 */

function loadOnce(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load sprite ${src}`));
    img.src = src;
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load one frame, retrying a few times. Under Tauri every frame comes through the
 * app's custom protocol, and asking it for a couple of hundred images in one burst
 * can make individual requests fail even though the file is there. A failed frame
 * is retried with a short backoff before the whole pet gives up.
 */
async function loadImage(src, tries = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await loadOnce(src);
    } catch (error) {
      if (attempt >= tries) throw error;
      await sleep(80 * attempt);
    }
  }
}

/** Run `job` over `items` with at most `limit` in flight, keeping result order. */
async function mapLimited(items, limit, job) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await job(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Frames in flight at once. Enough to load all of them in well under a second from
// the embedded assets, few enough not to swamp the protocol handler.
const LOAD_CONCURRENCY = 8;

export async function loadSprites(base) {
  const response = await fetch(`${base}manifest.json`);
  if (!response.ok) {
    throw new Error(
      `no sprite manifest at ${base}manifest.json — run: npm run assets`
    );
  }
  const manifest = await response.json();

  // Every frame of every action through one bounded queue, rather than all ~220 at
  // once; see loadImage.
  const entries = Object.entries(manifest.actions);
  // Unique paths: the pipeline stores a repeated frame once and points every use of
  // it at that one file.
  const all = [...new Set(entries.flatMap(([, spec]) => spec.frames))];
  const images = await mapLimited(all, LOAD_CONCURRENCY, (rel) => loadImage(base + rel));
  const byPath = new Map(all.map((rel, i) => [rel, images[i]]));

  const clips = {};
  for (const [name, spec] of entries) {
    const frames = spec.frames.map((rel) => byPath.get(rel));
    clips[name] = {
      name,
      frames,
      fps: spec.fps,
      loop: spec.loop,
      tags: spec.tags ?? [],
      // Per-frame seconds when the manifest has them (key poses held, in-betweens
      // quick); otherwise every frame lasts 1/fps.
      durations: spec.durations ?? null,
      ends: spec.durations ? cumulative(spec.durations) : null,
      seconds: spec.durations
        ? spec.durations.reduce((a, b) => a + b, 0)
        : frames.length / spec.fps,
      // Rigged walk only: canvas px/s a planted paw slides back. Moving the cat at
      // any other speed makes its feet skate.
      groundSpeed: spec.groundSpeed ?? null,
    };
  }

  return {
    canvas: manifest.canvas,
    baseline: manifest.baseline,
    // Drawn height of the resting sit, used to size the render box so the cat lands
    // on a fixed number of screen pixels whatever the pipeline's global scale did.
    sitHeight: manifest.sitHeight,
    clips,
  };
}

function cumulative(durations) {
  let t = 0;
  return durations.map((d) => (t += d));
}

/** Which frame index of a clip is showing after `elapsed` seconds. */
export function frameIndexAt(clip, elapsed) {
  const n = clip.frames.length;
  // A negative time would give index -1, and `-1 % n` stays -1 in JavaScript: no
  // frame. One-frame clips hid this (`-1 % 1` is -0, which indexes frame 0) until the
  // resting sit became a 24-frame loop.
  let t = Math.max(0, elapsed || 0);
  if (!clip.ends) {
    const i = Math.floor(t * clip.fps);
    return clip.loop ? i % n : Math.min(i, n - 1);
  }
  if (clip.loop) t %= clip.seconds;
  else if (t >= clip.seconds) return n - 1;
  // Clips are short (under 30 frames), so a linear scan is fine.
  let i = 0;
  while (i < n - 1 && t >= clip.ends[i]) i += 1;
  return i;
}

/** Which frame of a clip is showing after `elapsed` seconds. */
export function frameAt(clip, elapsed) {
  return clip.frames[frameIndexAt(clip, elapsed)];
}
