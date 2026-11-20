/**
 * Drives the 2.5D deformation (mesh25d.js) of the resting sit, in real time.
 *
 * DOM-free, like Brain: the renderer feeds it the action that is playing, the cursor
 * relative to the cat's face, and dt; it hands back the mesh parameters to draw with.
 *
 * While the cat sits it breathes, flicks an ear or the tail tip now and then, and
 * looks about: at the cursor when the cursor has moved nearby recently, otherwise an
 * occasional glance to one side. In any other action every motion relaxes back to
 * zero, so whatever the cat does next starts from the painting as drawn.
 */

// The actions drawn from the tilt sheet's front sit, which share its placement on the
// sprite canvas and so can all be deformed with SIT_RIG.
export const FAMILY = new Set(['sit', 'blink', 'head_tilt', 'held']);
// Of those, the ones the cat is idling in: live motion only plays during these.
const LIVE = new Set(['sit', 'blink']);

const BREATH_SECONDS = 3.2;
// How quickly the head follows its target and everything relaxes (1/s).
const LOOK_RATE = 5;
const RELAX_RATE = 9;
// Cursor following: only a cursor this close (in sitting heights from the face) and
// moved within this many seconds holds the cat's attention.
const FOLLOW_REACH = 4.5;
const FOLLOW_SECONDS = 2.5;
// Head limits, radians. Kept small on purpose: a single painted layer only reads as
// a turning head for small offsets; past ~0.25 the face visibly slides and stretches.
const MAX_YAW = 0.22;
const MAX_PITCH = 0.15;

const pulse = (t, len) => (t < 0 || t > len ? 0 : Math.sin((Math.PI * t) / len));

export class Live25D {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.time = 0;
    this.breathPhase = 0;
    this.breathAmp = 0;
    this.yaw = 0;
    this.pitch = 0;
    // Idle glances when the cursor is not holding the cat's attention.
    this.glance = { yaw: 0, pitch: 0, until: this._rand(2, 6) };
    this.earAt = -1;
    this.nextEar = this._rand(4, 10);
    this.tailAt = -1;
    this.nextTail = this._rand(3, 8);
    this.cursorSeen = -Infinity;
    this.lastCursor = null;
    this.params = { yaw: 0, pitch: 0, breath: 0, ear: 0, tail: 0 };
  }

  _rand(lo, hi) {
    return lo + this.rng() * (hi - lo);
  }

  /**
   * Advance by `dt` seconds.
   *   action  the brain's current action
   *   cursor  { dx, dy } from the cat's face to the cursor, in sitting heights
   *           (+dx screen right, +dy down), or null when unknown
   * Returns the parameters for this frame (the same object every time).
   */
  update(dt, action, cursor) {
    this.time += dt;
    const t = this.time;
    const live = LIVE.has(action);

    // Track movement, not position: a cursor parked next to the cat is ignored.
    if (cursor) {
      const moved = !this.lastCursor
        || Math.abs(cursor.dx - this.lastCursor.dx) + Math.abs(cursor.dy - this.lastCursor.dy) > 0.02;
      if (moved && Math.hypot(cursor.dx, cursor.dy) < FOLLOW_REACH) this.cursorSeen = t;
      this.lastCursor = { dx: cursor.dx, dy: cursor.dy };
    }

    let targetYaw = 0;
    let targetPitch = 0;
    if (live) {
      if (cursor && t - this.cursorSeen < FOLLOW_SECONDS) {
        // atan keeps a far cursor from cranking the head past what reads well.
        // atan saturates smoothly, so the head eases into its limit instead of
        // hitting it.
        targetYaw = MAX_YAW * (2 / Math.PI) * Math.atan(cursor.dx * 1.2);
        targetPitch = MAX_PITCH * (2 / Math.PI) * Math.atan(cursor.dy * 1.2);
      } else {
        if (t >= this.glance.until) {
          // Alternate: mostly facing front, now and then a look to one side.
          const looking = this.glance.yaw !== 0 || this.glance.pitch !== 0;
          if (looking || this.rng() < 0.35) {
            this.glance = { yaw: 0, pitch: 0, until: t + this._rand(3, 8) };
          } else {
            const side = this.rng() < 0.5 ? -1 : 1;
            this.glance = {
              yaw: side * this._rand(0.08, 0.18),
              pitch: this._rand(-0.06, 0.05),
              until: t + this._rand(1.2, 2.8),
            };
          }
        }
        targetYaw = this.glance.yaw;
        targetPitch = this.glance.pitch;
      }

      if (t >= this.nextEar) {
        this.earAt = t;
        this.nextEar = t + this._rand(6, 14);
      }
      if (t >= this.nextTail) {
        this.tailAt = t;
        this.nextTail = t + this._rand(5, 12);
      }
    } else {
      // Not idling: cancel flicks in progress so they do not resume mid-way.
      this.earAt = -1;
      this.tailAt = -1;
    }

    const kl = 1 - Math.exp(-dt * (live ? LOOK_RATE : RELAX_RATE));
    this.yaw += (targetYaw - this.yaw) * kl;
    this.pitch += (targetPitch - this.pitch) * kl;
    if (!live && Math.abs(this.yaw) < 1e-3 && Math.abs(this.pitch) < 1e-3) {
      this.yaw = 0;
      this.pitch = 0;
    }

    // Breathing keeps its phase running; its depth fades in and out with idling, so
    // returning to the sit never restarts it with a jump.
    this.breathPhase = (this.breathPhase + dt / BREATH_SECONDS) % 1;
    const kb = 1 - Math.exp(-dt * (live ? 2 : RELAX_RATE));
    this.breathAmp += ((live ? 1 : 0) - this.breathAmp) * kb;
    if (!live && this.breathAmp < 1e-3) this.breathAmp = 0;

    const p = this.params;
    p.yaw = this.yaw;
    p.pitch = this.pitch;
    p.breath = this.breathAmp * (0.5 - 0.5 * Math.cos(2 * Math.PI * this.breathPhase));
    p.ear = -0.22 * pulse(t - this.earAt, 0.25) * (this.earAt >= 0 ? 1 : 0);
    p.tail = -0.32 * pulse(t - this.tailAt, 0.9) * (this.tailAt >= 0 ? 1 : 0);
    return p;
  }
}
