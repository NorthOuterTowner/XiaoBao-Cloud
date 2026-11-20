// 2.5D mesh deformation of the painted sprites (Live2D-style, on one layer).
//
// The cat stays the original painting: a frame is drawn as a texture on a fine
// triangle grid, and only the grid's vertices move. Small, smooth vertex motions
// read as depth:
//
//   * Head turn / nod. The head is treated as a dome. A point's height on the dome
//     (`z`, 1 at the face centre, 0 at the outline) sets how far it travels, so the
//     eyes and nose slide further than the cheeks and the outline barely moves.
//     That parallax is what reads as the head rotating rather than sliding. The
//     ears sit behind the dome and only get the small whole-head shift, so they
//     lag behind the face the way the back of a real head does.
//   * The body twists a little after the head; the paws stay planted.
//   * Breathing widens the chest and lifts everything above it, fading out at the
//     floor; an ear and the tail tip rotate about their roots.
//
// Every motion is a pure function of (x, y, params), in the 256px sprite canvas'
// pixels, so it can be checked without a GPU (see `deformPoint`). Frames that share
// a pose (sit and the blink frames) share a rig, so swapping the texture mid-motion
// for a blink is seamless.

const GRID_STEP = 4;

const smooth = (e0, e1, v) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const bell = (lo, hi, v) => {
  const mid = (lo + hi) / 2;
  return smooth(lo, mid, v) * smooth(hi, mid, v);
};

/**
 * The resting front sit (assets/sprites/sit/000.png and blink/*), canvas px.
 * Measured on the 256px sprite: ear tips (82,97) and (157,96), eyes (100,151) and
 * (135,151), nose (118,164), chin ~180, paws on row 251, tail curled bottom right.
 */
export const SIT_RIG = {
  canvas: 256,
  ground: 251,
  // The head dome: centre and radii. Its lower edge is the chin.
  head: { cx: 118, cy: 146, rx: 56, ry: 46 },
  // Rows over which the head's motion fades into the chest (fully on above `from`).
  neck: { from: 178, to: 206 },
  // px of travel per radian: `face` scales with dome height, `all` moves the whole
  // head (ears included). Their ratio is the strength of the parallax.
  yaw: { face: 26, all: 9 },
  pitch: { face: 16, all: 6 },
  // Body twist under a turned head, as a fraction of the head's whole-head shift.
  bodyFollow: 0.35,
  breath: { cx: 118, rows: [182, 250], widen: 0.028, lift: 1.6 },
  // The cat's left ear, on screen right. Rotates about its base.
  ear: { pivot: [151, 124], x: [128, 182], rows: [128, 104] },
  // The eyes: centres and the radii of the patch a blink frame is allowed to change.
  eyes: { centres: [[100, 151], [136, 151]], rx: 15, ry: 12 },
  // Tail, curled on the floor at the bottom right (x 161-204, rows 216-252); rotates
  // about its root under the haunch, more toward the tip.
  tail: { pivot: [164, 244], x: [160, 200], rows: [200, 266] },
};

/** Neutral parameters; every field is optional when calling `deformPoint`. */
export const REST = Object.freeze({ yaw: 0, pitch: 0, breath: 0, ear: 0, tail: 0 });

/** True when `params` leaves every pixel where the painting has it. */
export function isRest(params) {
  return !params || (!params.yaw && !params.pitch && !params.breath && !params.ear && !params.tail);
}

function rotateAbout(x, y, [px, py], a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - px;
  const dy = y - py;
  return [px + c * dx - s * dy, py + s * dx + c * dy];
}

/**
 * Where source pixel (x, y) is drawn for `params`:
 *   yaw    head turn, radians, + turns toward screen right
 *   pitch  head nod, radians, + looks down
 *   breath 0 (exhaled, the painting as drawn) .. 1 (full breath in)
 *   ear    ear flick, radians, + rotates clockwise on screen
 *   tail   tail-tip flick, radians, - lifts the tip
 */
export function deformPoint(x, y, params, rig = SIT_RIG) {
  const { yaw = 0, pitch = 0, breath = 0, ear = 0, tail = 0 } = params;
  let px = x;
  let py = y;

  // Local motions first, on the parts' own rest positions.
  if (ear) {
    const w = smooth(rig.ear.rows[0], rig.ear.rows[1], y) * bell(rig.ear.x[0], rig.ear.x[1], x);
    if (w > 0) [px, py] = rotateAbout(px, py, rig.ear.pivot, ear * w);
  }
  if (tail) {
    // Grows from the root outward, so the tail bends instead of turning rigidly.
    const w = smooth(rig.tail.x[0], rig.tail.x[1], x) * bell(rig.tail.rows[0], rig.tail.rows[1], y);
    if (w > 0) [px, py] = rotateAbout(px, py, rig.tail.pivot, tail * w);
  }
  if (breath) {
    const b = rig.breath;
    px += (x - b.cx) * b.widen * breath * bell(b.rows[0], b.rows[1], y);
    py -= b.lift * breath * smooth(rig.ground, b.rows[0], y);
  }

  // Head turn and nod: dome parallax, fading out down the neck.
  if (yaw || pitch) {
    const h = rig.head;
    const u = (x - h.cx) / h.rx;
    const v = (y - h.cy) / h.ry;
    const q = Math.max(0, 1 - (u * u + v * v));
    // (1 - r^2)^2: flat-topped dome whose slope is zero at the outline, so the
    // moving face and the still outline meet without a crease.
    const z = q * q;
    const w = smooth(rig.neck.to, rig.neck.from, y);
    px += w * (Math.sin(yaw) * (rig.yaw.face * z + rig.yaw.all));
    py += w * (Math.sin(pitch) * (rig.pitch.face * z + rig.pitch.all));
    // The body turns a little after the head, pivoting on the planted paws.
    const body = (1 - w) * smooth(rig.ground, rig.neck.to - 10, y);
    px += body * rig.bodyFollow * Math.sin(yaw) * rig.yaw.all;
  }
  return [px, py];
}

/**
 * The source pixel drawn at screen point (x, y) for `params`: the inverse of
 * `deformPoint`, for hit testing against the undeformed frame. The deformation is a
 * small, smooth displacement, so a few fixed-point steps converge to well under a
 * pixel.
 */
export function undeformPoint(x, y, params, rig = SIT_RIG) {
  if (isRest(params)) return [x, y];
  let sx = x;
  let sy = y;
  for (let i = 0; i < 6; i += 1) {
    const [dx, dy] = deformPoint(sx, sy, params, rig);
    sx += x - dx;
    sy += y - dy;
  }
  return [sx, sy];
}

/**
 * A blink frame reduced to its eyes: `base` (the resting sit) with only the eye
 * patches taken from `frame`.
 *
 * The blink frames came out of the generator as whole new drawings of the cat, so
 * every fur stroke differs slightly from the sit. Played as they are, each blink
 * made the whole coat shimmer. Feathered ellipses around the eyes keep the closed
 * lids and nothing else. Returns a canvas, usable anywhere an image is.
 */
export function eyesOnto(base, frame, rig = SIT_RIG) {
  const size = rig.canvas;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  };
  // Mask: 1 inside 0.75 of the radii, fading to 0 at 1.25, unioned over both eyes.
  const mask = make();
  const m = mask.getContext('2d');
  m.globalCompositeOperation = 'lighten';
  const { centres, rx, ry } = rig.eyes;
  for (const [cx, cy] of centres) {
    m.save();
    m.translate(cx, cy);
    m.scale(1, ry / rx);
    const g = m.createRadialGradient(0, 0, 0, 0, 0, rx * 1.25);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.6, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = g;
    m.fillRect(-rx * 1.3, -rx * 1.3, rx * 2.6, rx * 2.6);
    m.restore();
  }
  const eyes = make();
  const e = eyes.getContext('2d');
  e.drawImage(frame, 0, 0, size, size);
  e.globalCompositeOperation = 'destination-in';
  e.drawImage(mask, 0, 0);

  const out = make();
  const o = out.getContext('2d');
  o.drawImage(base, 0, 0, size, size);
  o.drawImage(eyes, 0, 0);
  return out;
}

// ---- WebGL ------------------------------------------------------------------------------

const VERT = `
attribute vec2 aPos;
attribute vec2 aUv;
uniform float uCanvas;
varying vec2 vUv;
void main() {
  vUv = aUv;
  vec2 c = aPos / uCanvas * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv) * uAlpha;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

/**
 * Draws sprite frames through the deforming mesh onto a WebGL canvas.
 * Colours are premultiplied end to end, so soft fur edges composite cleanly on a
 * transparent window.
 */
export class MeshRenderer {
  /**
   * `maxTextures` bounds GPU memory: the app has ~200 frames, and keeping every one
   * resident would hold ~70 MB of textures for frames that play a few times an hour.
   * Least recently drawn frames are dropped and re-uploaded when next needed.
   */
  constructor(canvas, { rig = SIT_RIG, preserveDrawingBuffer = false, maxTextures = 64 } = {}) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      preserveDrawingBuffer,
    });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.rig = rig;
    this.maxTextures = maxTextures;
    this.textures = new Map();

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      uv: gl.getAttribLocation(prog, 'aUv'),
      canvas: gl.getUniformLocation(prog, 'uCanvas'),
      tex: gl.getUniformLocation(prog, 'uTex'),
      alpha: gl.getUniformLocation(prog, 'uAlpha'),
    };

    // Rest grid over the whole sprite canvas.
    const n = rig.canvas / GRID_STEP + 1;
    this.n = n;
    this.rest = new Float32Array(n * n * 2);
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const k = (j * n + i) * 2;
        this.rest[k] = i * GRID_STEP;
        this.rest[k + 1] = j * GRID_STEP;
        uv[k] = (i * GRID_STEP) / rig.canvas;
        uv[k + 1] = (j * GRID_STEP) / rig.canvas;
      }
    }
    const idx = new Uint16Array((n - 1) * (n - 1) * 6);
    let t = 0;
    for (let j = 0; j < n - 1; j += 1) {
      for (let i = 0; i < n - 1; i += 1) {
        const a = j * n + i;
        idx.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], t);
        t += 6;
      }
    }
    this.count = idx.length;
    this.pos = new Float32Array(this.rest.length);

    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    this.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos.byteLength, gl.DYNAMIC_DRAW);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.lastKey = null;
  }

  texture(image) {
    let tex = this.textures.get(image);
    if (tex) {
      // Map order is insertion order: re-inserting marks it most recently used.
      this.textures.delete(image);
      this.textures.set(image, tex);
      return tex;
    }
    const { gl } = this;
    while (this.textures.size >= this.maxTextures) {
      const [oldest, old] = this.textures.entries().next().value;
      gl.deleteTexture(old);
      this.textures.delete(oldest);
    }
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(image, tex);
    return tex;
  }

  /** Recompute vertex positions for `params` (skipped when nothing changed). */
  pose(params) {
    const key = `${params.yaw}|${params.pitch}|${params.breath}|${params.ear}|${params.tail}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const { rest, pos } = this;
    for (let k = 0; k < rest.length; k += 2) {
      const [x, y] = deformPoint(rest[k], rest[k + 1], params, this.rig);
      pos[k] = x;
      pos[k + 1] = y;
    }
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
  }

  clear() {
    const { gl, canvas } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Draw `image` deformed by `params` at opacity `alpha` over what is already there. */
  draw(image, params = REST, alpha = 1) {
    const { gl, loc } = this;
    this.pose({ ...REST, ...params });
    gl.useProgram(this.prog);
    gl.uniform1f(loc.canvas, this.rig.canvas);
    gl.uniform1f(loc.alpha, alpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture(image));
    gl.uniform1i(loc.tex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.enableVertexAttribArray(loc.uv);
    gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
  }
}
