// First, so `window.pet` exists before anything below runs.
import './bridge.js';
import { loadSprites, frameAt } from './sprites.js';
import { Brain } from './behavior.js';
import { Audio_ } from './audio.js';
import { Settings } from './settings.js';
import { MeshRenderer, SIT_RIG, REST, isRest, undeformPoint, eyesOnto } from './mesh25d.js';
import { Live25D, FAMILY } from './live25d.js';

const SPRITE_BASE = '../assets/sprites/';
const HEART_ICON = '../icons/icons8-heart-48.png';
// The treat, one image per bite taken. All three are drawn on a common canvas at a
// common scale by tools/build_treat.py, so swapping between them makes the fish
// shrink in place instead of jumping about. Past the end of this list it is gone.
const TREAT_STAGES = [
  '../icons/fish.png',
  '../icons/fish_bitten.png',
  '../icons/fish_crumbs.png',
];

// Short cross-fade on every action change. The art comes from three separate
// generator runs, so handing over between families can pop; 90ms of blend hides it
// without feeling like a dissolve.
const FADE_SECONDS = 0.09;
// Alpha above which a pixel counts as "the cat" for mouse hit testing.
const HIT_ALPHA = 24;
// How tall the cat should stand on screen, in pixels.
//
// The render box is derived from this, not hardcoded. A sprite canvas is bigger than
// the cat inside it by whatever margin the asset pipeline's global scale happened to
// leave, and that margin moves every time a sheet is added or redrawn -- so a
// hardcoded box size silently resizes the cat. The manifest reports how tall the
// resting sit was actually drawn, which is what makes this stable.
const TARGET_SIT_HEIGHT = 124;
// Fallback walk speed in screen px/s, for a manifest without a rigged walk.
const WALK_SPEED = 51;
// How far to the side of the cat's centre a heart pops, in screen pixels.
const HEART_OFFSET = 48;
// Treat *length* as a fraction of the cat's height -- the fish is long and thin, so
// sizing it by height would make a dried fish longer than the cat is tall.
const TREAT_SCALE = 0.45;
// How far to the side of the cat's centre the treat lands, as a fraction of the
// cat's sitting height. The front-facing feeding frames draw the mouth a little left
// of the box centre (canvas x ~113 of 256, with the sit 157 tall).
//
// These are measured against the cat as drawn, not its render box: how much empty
// margin the box has around the cat moves whenever the asset pipeline's global
// scale does, and box fractions silently drifted with it.
const TREAT_MOUTH_X = -0.096;
// Where the fish comes to rest: its centre this many sitting-heights above the
// floor: the mouth line, between the open mouth of feed_wait (canvas y ~158) and the
// lower, closed chewing mouth (y ~170). The fall stops here.
const TREAT_MOUTH = 0.564;
// The fish is held crosswise in the mouth by its head end, the body sticking out to
// the cat's left (screen right): this fraction of the fish image's width, measured
// from its head end, sits on the mouth. 0.22 is where the bitten-down pieces start,
// so the fish still reaches the mouth after each bite.
const TREAT_BITE = 0.22;
// How far the mouse has to move with the button down before a click becomes a drag.
const DRAG_THRESHOLD = 4;
// Proof of life for the main process while the cat holds the mouse.
const HEARTBEAT_SECONDS = 0.4;
// A carried cat keeps the window grabbing the mouse, so a drag that never ends would
// lock the desktop out. The window covers the work area but not the taskbar, so a
// mouseup over the taskbar can go missing. If a drag goes completely idle this long,
// assume the button was let go somewhere we could not see and drop the cat.
const DRAG_IDLE_LIMIT_SECONDS = 5;
// While carried the cat hangs from the point it was grabbed and swings like a
// pendulum: dragging it sideways makes it lag behind (degrees of lean per px/s of
// sideways speed, up to SWING_MAX), and it sways back and forth a little when the
// hand stops. Stiffness and damping are the spring's; slightly underdamped, so a
// stop gives one or two visible swings rather than a wobble that never settles.
const SWING_PER_SPEED = 0.03;
const SWING_MAX = 22;
const SWING_STIFFNESS = 90;
const SWING_DAMPING = 9;

const catEl = document.getElementById('cat');

// The cat is drawn through the 2.5D mesh (mesh25d.js) on WebGL: frames of the front
// sit family get the live head turn, breathing and flicks, every other frame goes
// through the same mesh at rest, which is the painting exactly as drawn. Without
// WebGL the canvas falls back to plain 2D drawing of the baked frames. A canvas can
// only ever have one kind of context, so WebGL is asked for first.
let mesh = null;
let ctx = null;
try {
  mesh = new MeshRenderer(catEl);
} catch (error) {
  console.warn('cat: no WebGL, drawing flat frames', error);
  ctx = catEl.getContext('2d');
}
if (mesh) {
  // A lost GPU context (driver reset, sleep/resume) would otherwise leave the cat
  // invisible for good. Asking to keep it lets the browser restore it, and the
  // restored context starts empty, so the mesh and its textures are rebuilt.
  catEl.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    console.warn('cat: WebGL context lost');
  });
  catEl.addEventListener('webglcontextrestored', () => {
    mesh = new MeshRenderer(catEl);
  });
}
// Where the face sits on the sprite canvas: the cat looks from here at the cursor.
const FACE = [SIT_RIG.head.cx, 150];
const live = new Live25D();
const heartsEl = document.getElementById('hearts');
const treatEl = document.getElementById('treat');
const errorEl = document.getElementById('error');

let sprites = null;
let brain = null;
let audio = null;
let settings = null;
// catSize is a placeholder until the manifest loads; applyStage derives the real one.
let stage = { width: 0, height: 0, catSize: 0 };
let footOffset = 0;

let hitCtx = null;
let shownImage = null;
// The mesh parameters the frame on screen was drawn with (REST when undeformed), so
// the hit test can follow the deformation and a cross-fade can hold the outgoing
// frame exactly as it last looked.
let shownParams = REST;
let fadeFrom = null;
let fadeFromParams = REST;
let fadeT = 1;
let lastSeq = -1;

let lastMouse = null;
let interactive = false;
let beatIn = 0;

// Set on mousedown over the cat; becomes a drag once the mouse moves far enough.
let press = null;

// The carried cat's swing: angle in degrees (clockwise), its rate, the smoothed
// sideways speed driving it, and the pivot (the grab point, in box pixels).
const swing = { angle: 0, rate: 0, vx: 0, lastX: null, pivotX: 0, pivotY: 0 };

// True between dropping a file and the native side coming back with the user's
// answer. A leave can follow a successful drop, and acting on it would snap the
// cat's mouth shut while the confirmation is still up.
let awaitingFeedAnswer = false;

// ---- layout ---------------------------------------------------------------------------

/**
 * Render box size that puts the drawn cat at TARGET_SIT_HEIGHT screen pixels, scaled
 * by the Settings "cat size" slider (1.0 until it loads, so boot is unaffected).
 */
function catBoxSize() {
  const scale = settings ? settings.catScale : 1;
  return Math.round((TARGET_SIT_HEIGHT * scale * sprites.canvas) / sprites.sitHeight);
}

/** Re-apply the layout at the current size, after the cat-size slider moves. */
function relayoutForSize() {
  if (!sprites) return;
  const before = stage.catSize;
  applyStage(stage);
  // Keep the cat's left edge from drifting as it grows: nudge x so its centre holds.
  if (brain && before) {
    brain.x = Math.min(Math.max(brain.x + (before - stage.catSize) / 2, brain.minX), brain.maxX);
  }
}

/**
 * Walk speed in screen px/s. The walk is rigged so a planted paw slides back at the
 * manifest's groundSpeed (canvas px/s); scaled to the render box, that is exactly the
 * speed that keeps the paws still on the floor, at any cat size.
 */
function walkSpeed() {
  const ground = sprites.clips.walk_left?.groundSpeed;
  return ground ? (ground * stage.catSize) / sprites.canvas : WALK_SPEED;
}

function applyStage(info) {
  stage = { ...stage, ...info, catSize: catBoxSize() };
  const size = stage.catSize;

  catEl.width = size;
  catEl.height = size;
  catEl.style.width = `${size}px`;
  catEl.style.height = `${size}px`;

  // Frames are drawn on a 256px canvas whose ground line sits a few pixels above the
  // bottom edge. Pushing the canvas down by that gap puts the paws on the floor.
  footOffset = ((sprites.canvas - sprites.baseline) / sprites.canvas) * size;
  catEl.style.bottom = `${-footOffset}px`;

  hitCtx.canvas.width = size;
  hitCtx.canvas.height = size;
  shownImage = null; // force the hit mask to be redrawn at the new size

  if (brain) {
    brain.setBounds(0, Math.max(0, stage.width - size), walkSpeed());
  }
}

/** How tall the resting sit is on screen, in px. */
function sitPx() {
  return (sprites.sitHeight * stage.catSize) / sprites.canvas;
}

/** The sprite ground line, in px down from the top of the cat's box. */
function groundInBox() {
  return (sprites.baseline * stage.catSize) / sprites.canvas;
}

/** Top of the cat's canvas, in window pixels, when it is standing on the floor. */
function floorTop() {
  return window.innerHeight - stage.catSize + footOffset;
}

/** Top of the cat's canvas right now, accounting for how high it is off the floor. */
function catTop() {
  return floorTop() - brain.y;
}

// ---- drawing --------------------------------------------------------------------------

let missingFrameReported = false;

/** The cursor relative to the cat's face, in sitting heights, or null if unknown. */
function cursorFromFace() {
  if (!lastMouse || !sprites) return null;
  const k = stage.catSize / sprites.canvas;
  const sit = sitPx();
  return {
    dx: (lastMouse.x - (brain.x + FACE[0] * k)) / sit,
    dy: (lastMouse.y - (catTop() + FACE[1] * k)) / sit,
  };
}

/**
 * The frame to show and the mesh parameters to show it with.
 *
 * The resting sit is drawn live: its first frame, the untouched painting, deformed by
 * Live25D every tick. (The sit clip's other frames bake the same breathing and
 * flicks in, for the flat fallback.) The rest of its family -- blink, head tilt,
 * held -- plays its frames through the same rig, so a blink lands mid-turn without a
 * jump and a head tilt starts from wherever the head was looking.
 */
function frameAndParams(dt) {
  const clip = sprites.clips[brain.action];
  const params = live.update(brain.paused ? 0 : dt, brain.action, cursorFromFace());
  if (!clip) return { image: null, params: REST };
  if (!mesh || !FAMILY.has(brain.action)) {
    return { image: frameAt(clip, brain.elapsed), params: REST };
  }
  const image = brain.action === 'sit' ? clip.frames[0] : frameAt(clip, brain.elapsed);
  return { image, params: { ...params } };
}

function draw(dt) {
  const clip = sprites.clips[brain.action];
  const { image, params } = frameAndParams(dt);
  if (!image) {
    // Never hand drawImage nothing: it throws, and a throw here used to end the frame
    // loop for good, leaving no cat and no error on screen. Report it once instead.
    if (!missingFrameReported) {
      missingFrameReported = true;
      console.error('cat: no frame to draw', {
        action: brain.action,
        elapsed: brain.elapsed,
        frames: clip?.frames.length,
        missing: clip?.frames.filter((f) => !f).length,
        fps: clip?.fps,
        seconds: clip?.seconds,
      });
    }
    return;
  }

  if (brain.seq !== lastSeq) {
    fadeFrom = shownImage;
    fadeFromParams = shownParams;
    fadeT = 0;
    lastSeq = brain.seq;
  }
  if (fadeFrom) {
    fadeT = Math.min(1, fadeT + dt / FADE_SECONDS);
    if (fadeT >= 1) fadeFrom = null;
  }

  const size = stage.catSize;
  if (mesh) {
    // Same blend as the flat path below, for the same reason: outgoing frame opaque,
    // incoming one over it at fadeT, so the cat never goes see-through mid-fade.
    mesh.clear();
    if (fadeFrom) mesh.draw(fadeFrom, fadeFromParams, 1);
    mesh.draw(image, params, fadeFrom ? fadeT : 1);
  } else if (fadeFrom) {
    ctx.clearRect(0, 0, size, size);
    // Hold the outgoing frame fully opaque and blend the incoming one over it.
    //
    // The obvious version -- outgoing at `1 - fadeT`, incoming at `fadeT` -- is only
    // correct on an opaque background. Here the canvas starts empty, so source-over
    // leaves a combined alpha of `fadeT + (1 - fadeT)^2`, which bottoms out at 0.75
    // halfway through. On a transparent window that means the whole cat went 25%
    // see-through for the length of every cross-fade, and since the brain changes
    // action roughly every couple of seconds it read as a constant flicker against
    // the desktop.
    ctx.drawImage(fadeFrom, 0, 0, size, size);
    ctx.globalAlpha = fadeT;
    ctx.drawImage(image, 0, 0, size, size);
    ctx.globalAlpha = 1;
  } else {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(image, 0, 0, size, size);
  }

  shownParams = params;
  // The hit mask is the undeformed frame; overCatAt maps the cursor back through
  // the deformation before looking it up.
  if (image !== shownImage) {
    shownImage = image;
    hitCtx.clearRect(0, 0, size, size);
    hitCtx.drawImage(image, 0, 0, size, size);
  }

  updateSwing(dt);
  const move = `translate(${Math.round(brain.x)}px, ${-Math.round(brain.y)}px)`;
  if (swing.angle) {
    catEl.style.transformOrigin = `${swing.pivotX}px ${swing.pivotY}px`;
    catEl.style.transform = `${move} rotate(${swing.angle.toFixed(2)}deg)`;
  } else {
    catEl.style.transform = move;
  }
}

/**
 * Pendulum swing while the cat is carried. Moving it right drags the pivot right
 * and leaves the body behind, which is a clockwise lean (bottom to the left); the
 * spring then brings it back under the hand. Once dropped it springs upright fast,
 * so it is level by the time it lands.
 */
function updateSwing(dt) {
  if (brain.held) {
    if (swing.lastX === null) {
      swing.lastX = brain.x;
      swing.vx = 0;
      if (press) {
        swing.pivotX = press.offsetX;
        swing.pivotY = press.offsetY;
      }
    }
    const raw = dt > 0 ? (brain.x - swing.lastX) / dt : 0;
    swing.lastX = brain.x;
    // Smoothed over ~80ms: mousemove arrives in bursts, raw speed is spiky.
    swing.vx += (raw - swing.vx) * Math.min(1, dt * 12);
  } else {
    swing.lastX = null;
    swing.vx = 0;
  }

  const target = brain.held
    ? Math.max(-SWING_MAX, Math.min(SWING_MAX, swing.vx * SWING_PER_SPEED))
    : 0;
  // Stiffer and better damped once let go, so the cat lands upright.
  const k = brain.held ? SWING_STIFFNESS : SWING_STIFFNESS * 3;
  const c = brain.held ? SWING_DAMPING : SWING_DAMPING * 2.5;
  // Semi-implicit Euler, in small steps so a long frame cannot blow it up.
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i += 1) {
    swing.rate += (k * (target - swing.angle) - c * swing.rate) * h;
    swing.angle += swing.rate * h;
  }
  swing.angle = Math.max(-SWING_MAX * 1.5, Math.min(SWING_MAX * 1.5, swing.angle));
  if (!brain.held && Math.abs(swing.angle) < 0.05 && Math.abs(swing.rate) < 0.5) {
    swing.angle = 0;
    swing.rate = 0;
  }
}

// ---- mouse ----------------------------------------------------------------------------

/** Is this window-relative point on an opaque pixel of the cat as currently drawn? */
function overCatAt(clientX, clientY) {
  let bx = clientX - Math.round(brain.x);
  let by = clientY - catTop();
  if (!isRest(shownParams)) {
    // Back through the mesh: which pixel of the painting is drawn under the cursor.
    const k = sprites.canvas / stage.catSize;
    const [sx, sy] = undeformPoint(bx * k, by * k, shownParams);
    bx = sx / k;
    by = sy / k;
  }
  const x = Math.floor(bx);
  const y = Math.floor(by);
  if (x < 0 || y < 0 || x >= stage.catSize || y >= stage.catSize) return false;
  return hitCtx.getImageData(x, y, 1, 1).data[3] > HIT_ALPHA;
}

/**
 * Decide, every frame, whether the window should be taking mouse input, and tell the
 * main process. Checked on the frame loop rather than on mousemove alone, because the
 * cat walks out from under a stationary cursor and the window has to become
 * click-through again when it does.
 *
 * This window covers the whole work area, so "not over the cat" has to mean
 * click-through, or the pet would swallow every click on the desktop.
 */
function updateHit() {
  // The Settings panel is non-modal: the window only takes the mouse while the cursor
  // is over the panel (like the cat), so the rest of the desktop stays clickable.
  // A press that started on the panel (slider drag, title drag) keeps the mouse until
  // release, even if the cursor slides off the panel mid-drag.
  const overSettings =
    !!settings &&
    settings.open &&
    (settings.capturing || (!!lastMouse && settings.contains(lastMouse.x, lastMouse.y)));

  // While the cat is being carried the window has to keep taking input even when the
  // cursor runs ahead of the sprite, otherwise the drag drops the moment you move
  // faster than the cat follows.
  const over = brain.held || overSettings
    ? true
    : lastMouse
      ? overCatAt(lastMouse.x, lastMouse.y)
      : false;

  if (over !== interactive) {
    interactive = over;
    window.pet.setInteractive(over);
    document.body.classList.toggle('over-cat', over);
  }
  document.body.classList.toggle('carrying', brain.held);
}

// ---- the treat ------------------------------------------------------------------------

/**
 * Drawn size of the fish, keeping its own aspect.
 *
 * The fish has an *absolute* size, not scaled to the cat. Its length is a fraction of
 * the default cat height (TARGET_SIT_HEIGHT = 124px), so at 100% the fish is exactly
 * as long as a default-sized cat. Resizing the cat does NOT change the fish.
 * TREAT_SCALE is the default; the slider replaces it.
 */
function treatBox() {
  const scale = settings ? settings.fishScale : TREAT_SCALE;
  const width = Math.round(TARGET_SIT_HEIGHT * scale);
  const ratio =
    treatEl.naturalWidth && treatEl.naturalHeight
      ? treatEl.naturalHeight / treatEl.naturalWidth
      : 1;
  return { width, height: Math.max(1, Math.round(width * ratio)) };
}

/** Left edge the treat is currently placed at, so the DOM is only written on change. */
let treatLeft = null;

/**
 * Show the food wherever the brain says it is, or nothing at all.
 *
 * `brain.offer` is the single source of truth: it appears when a fish is offered, its
 * `bites` count picks the stage, and it is cleared once the cat swallows or gives up
 * -- so the treat cannot linger after the meal or outlive a cat picked up mid-bite.
 *
 * Only a fish is ever drawn. A dragged file deliberately has no sprite: putting a
 * fish on the floor for it would tell the user the cat ate a fish, when what actually
 * went down was their file.
 */
function placeTreat() {
  const offer = brain.offer;
  const bites = offer?.bites ?? 0;
  // Only a fish, and only once the cat has arrived and started opening its mouth
  // (`ready`). Before that the offer exists but the cat is still walking over, so
  // nothing should fall yet. A dragged file never has `auto`, so never a sprite:
  // putting a fish on the floor for it would say the cat ate a fish, not the file.
  const src = offer && offer.auto && offer.ready ? TREAT_STAGES[bites] : undefined;

  if (!src) {
    if (!treatEl.hidden) {
      treatEl.hidden = true;
      treatLeft = null;
    }
    return;
  }

  const { width, height } = treatBox();
  // In the cat's mouth, held by its head. The body sticks out over the cat's cheek
  // and stays inside the cat's own box, so it never hangs off the screen edge.
  const mouthX = offer.x + stage.catSize / 2 + sitPx() * TREAT_MOUTH_X;
  const left = Math.round(mouthX - width * TREAT_BITE);
  // The mouth's height: the top of the cat's box is `catTop()` window pixels down.
  // `bottom` is measured up from the window's bottom edge.
  const mouthBottom = Math.round(
    window.innerHeight - (catTop() + groundInBox() - sitPx() * TREAT_MOUTH) - height / 2
  );

  if (treatEl.hidden) {
    treatEl.width = width;
    treatEl.height = height;
    treatEl.style.bottom = `${mouthBottom}px`;
    // How far up the fall starts, set per drop so the fish always comes in from off
    // the top of the screen rather than a fixed distance above where it lands.
    // Showing the element is what starts the drop animation, so set this first.
    treatEl.style.setProperty('--drop', `${-(window.innerHeight - mouthBottom)}px`);
    treatEl.hidden = false;
  }
  if (treatEl.getAttribute('src') !== src) treatEl.setAttribute('src', src);
  if (left !== treatLeft) {
    treatLeft = left;
    treatEl.style.left = `${left}px`;
  }
}

function spawnHeart() {
  const size = stage.catSize;
  const heart = document.createElement('img');
  heart.className = 'heart';
  heart.src = HEART_ICON;

  // Just clear of the silhouette: beside the head rather than on top of it.
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = brain.x + size / 2 + side * HEART_OFFSET - 13 + (Math.random() - 0.5) * 8;
  // A little above the top of the head, measured off the cat rather than its box.
  const y = catTop() + groundInBox() - sitPx() * 1.29;
  heart.style.left = `${Math.round(x)}px`;
  heart.style.top = `${Math.round(y)}px`;

  heart.addEventListener('animationend', () => heart.remove());
  heartsEl.appendChild(heart);
}

/** Give up any drag in progress and put the cat back on the floor. */
function endDrag() {
  if (press && press.dragging) brain.release();
  press = null;
}

/** Last time the cursor moved during a drag, for the idle bail-out above. */
let lastDragMove = 0;

function wireEvents() {
  document.addEventListener('mousemove', (event) => {
    lastMouse = { x: event.clientX, y: event.clientY };

    if (!press) return;
    lastDragMove = performance.now();

    // A missed mouseup (dragged over the taskbar and released, say) would otherwise
    // leave the cat stuck to the cursor forever.
    if (event.buttons === 0) {
      endDrag();
      return;
    }

    if (!press.dragging) {
      const moved =
        Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y);
      if (moved < DRAG_THRESHOLD) return;
      press.dragging = true;
      brain.grab();
    }

    brain.carryTo(
      event.clientX - press.offsetX,
      floorTop() - (event.clientY - press.offsetY)
    );
  });

  document.addEventListener('mousedown', (event) => {
    // Hit-tested against where the click actually landed rather than against the
    // hovering state, which is a frame old by now and may have been computed for a
    // different cursor position or a different animation frame. The window only
    // receives a mousedown at all while it has the mouse, so this is a precision
    // check on top of the OS-level gate, not a replacement for it.
    if (event.button !== 0 || !overCatAt(event.clientX, event.clientY)) return;
    // The panel sits above the cat; a press on it belongs to the panel.
    if (settings.open && settings.contains(event.clientX, event.clientY)) return;
    lastDragMove = performance.now();
    press = {
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - brain.x,
      offsetY: event.clientY - catTop(),
      dragging: false,
    };
  });

  document.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    if (!press) return;
    if (press.dragging) {
      brain.release();
    } else {
      brain.poke();
      spawnHeart();
    }
    press = null;
  });

  // Leaving the window mid-drag counts as letting go.
  //
  // `lastMouse` is deliberately left alone. The native cursor poll is what keeps it
  // current, and it only reports movement: the window flipping back to click-through
  // can fire a mouseleave under a cursor that then holds still, and forgetting where
  // the pointer is would leave the cat deaf to it until the mouse moved again.
  document.addEventListener('mouseleave', () => {
    endDrag();
  });

  document.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || !overCatAt(event.clientX, event.clientY)) return;
    brain.pet();
  });

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (overCatAt(event.clientX, event.clientY)) window.pet.openMenu();
  });

  // ---- being fed a file ----------------------------------------------------------
  //
  // The native side owns the drag: it only reaches this window while the window has
  // the mouse, which it only has while the cursor is on the cat's own pixels -- so a
  // drag that gets this far is a drag over the cat, and no extra hit test is needed.
  // The page is told where the drag is and never which files; whether anything gets
  // eaten is decided natively, after asking.
  window.pet.onDrag(({ kind, x }) => {
    switch (kind) {
      case 'over':
        // Offer it where the cursor is, converted to where the cat should stand.
        brain.offerFood(x - stage.catSize / 2);
        return;
      case 'drop':
        // The cat keeps its mouth open while the user answers the confirmation. The
        // native side replies with 'eat' or 'cancelFeed'.
        awaitingFeedAnswer = true;
        return;
      case 'leave':
        if (!awaitingFeedAnswer) brain.cancelOffer();
        return;
      default:
        return;
    }
  });

  window.pet.onCommand((payload) => {
    const { name, ...data } = payload ?? {};
    // Settings is a view concern, not a brain one: open the panel next to the cat.
    if (name === 'settings') {
      if (settings.open) {
        settings.hide();
      } else {
        // Pass the cat's current position: left edge, width, and bottom edge from the
        // window top. The panel will position itself beside the cat.
        settings.show(brain.x, stage.catSize, floorTop());
      }
      return;
    }
    if (name === 'eat' || name === 'cancelFeed') awaitingFeedAnswer = false;
    brain.command(name, data);
    if (name === 'tilt') spawnHeart();
    // A finished meal is worth being pleased about, visibly.
    if (name === 'eat') spawnHeart();
  });
  window.pet.onResized(applyStage);

  // Where the pointer is while the window is click-through, which is almost always.
  // A click-through window hears nothing of the mouse, so without this the hit test
  // would never see the pointer arrive on the cat and the window would never take
  // the mouse back. While the window does have the mouse, ordinary mousemove events
  // keep `lastMouse` current as well; the two agree, both being CSS pixels.
  window.pet.onCursor((point) => {
    lastMouse = point;
  });
}

// ---- boot -----------------------------------------------------------------------------

function fail(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
  // Never leave a broken pet holding the mouse.
  window.pet.setInteractive(false);
  console.error(message);
}

async function main() {
  const hit = document.createElement('canvas');
  hitCtx = hit.getContext('2d', { willReadFrequently: true });

  sprites = await loadSprites(SPRITE_BASE);
  // Blink only the eyes: keep the sit's fur and take just the lids from each blink
  // frame (see eyesOnto). Repeated frames share one composite.
  const { sit: sitClip, blink: blinkClip } = sprites.clips;
  if (sitClip && blinkClip) {
    const made = new Map();
    blinkClip.frames = blinkClip.frames.map((frame) => {
      if (!made.has(frame)) made.set(frame, eyesOnto(sitClip.frames[0], frame));
      return made.get(frame);
    });
  }
  // Decode every stage of the treat up front. The swaps happen mid-chew, and a blank
  // frame while the next one loads would read as the fish vanishing a bite early.
  for (const src of TREAT_STAGES) {
    const preload = new Image();
    preload.src = src;
  }
  const info = await window.pet.stage();
  applyStage(info);

  brain = new Brain({
    clips: sprites.clips,
    minX: 0,
    maxX: Math.max(0, stage.width - stage.catSize),
    walkSpeed: walkSpeed(),
  });
  if (info.paused) brain.setPaused(true);

  audio = new Audio_();

  settings = new Settings({
    onVolume: (level) => audio.setVolume(level),
  });
  // The cat-size slider resizes the live cat; the fish-size one is read when a fish
  // next appears, so it needs no callback.
  settings.onCatSize = () => relayoutForSize();

  wireEvents();

  // Handle for poking at behaviour from the WebView's devtools in a debug build.
  // `overCatAt` is the same lookup the frame loop uses, exposed so the hit test can be
  // checked without depending on where the real cursor happens to be.
  window.__catDebug = {
    brain,
    spawnHeart,
    sprites,
    overCatAt,
    floorTop,
    catTop,
    treatEl,
    audio,
  };

  let last = performance.now();
  const tick = (now) => {
    // Scheduled first, so an exception anywhere below costs one frame rather than
    // stopping the cat for good.
    requestAnimationFrame(tick);
    // Measured delta, never a fixed step: a dropped or throttled frame must not
    // stretch the animation or slow the walk.
    //
    // Never negative. requestAnimationFrame passes the time the frame *started*,
    // which can be earlier than the performance.now() taken just before the first
    // frame was requested. That made the first dt slightly negative, the clip's
    // elapsed time negative, and the frame index -1 -- no frame at all.
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    // Self-heal a drag whose mouseup never arrived, before it can lock the desktop.
    if (press && now - lastDragMove > DRAG_IDLE_LIMIT_SECONDS * 1000) {
      console.warn('cat: drag went idle, letting go');
      endDrag();
    }

    brain.update(dt);
    draw(dt);
    placeTreat();
    audio.update(brain.action);
    updateHit();

    if (interactive) {
      beatIn -= dt;
      if (beatIn <= 0) {
        beatIn = HEARTBEAT_SECONDS;
        window.pet.heartbeat();
      }
    }
  };
  requestAnimationFrame(tick);
}

main().catch((err) => fail(String(err && err.message ? err.message : err)));
