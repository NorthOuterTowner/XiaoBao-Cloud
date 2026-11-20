// Desktop Cat: a chibi long-haired grey-taupe tabby kitten, built from rounded primitives.
// Plush-toy look: soft sheen fur material, tabby stripes painted into vertex colours in rig (world)
// space so the pattern flows continuously across separate parts.
// Units are meters (the kitten is ~0.33 m tall), +Y up, facing +Z. See the skill's authoring.md.
import {
  THREE, Rig, TAU, smooth, wave, mix, place, limb, spike, blob, skinnedTube, colorize,
  proceduralTexture, fbm, clonePose,
} from './rig-kit.js';

// ---------------------------------------------------------------- palette (sampled from rsrc/ref)
const PAL = {
  base: '#7e6a5c', // warm grey-taupe
  light: '#a8927f', // fur tips, belly
  cream: '#cdb59d', // muzzle, chest
  dark: '#3e3029', // tabby stripes
  deep: '#2a211c',
  pink: '#e2a19b',
  nose: '#d48a85',
};

const BODY_Y = 0.13;
const FRONT_UPPER = 0.055;
const FRONT_LOWER = 0.04;
const HIND_UPPER = 0.05;
const HIND_LOWER = 0.05;
const IDLE = 4.0; // seconds: two breaths and one blink per loop
const BLINK_AT = 0.55;

// ---------------------------------------------------------------- pattern helpers (pure functions)
const fract = (v) => v - Math.floor(v);
function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Smooth 3D value noise in [0, 1]; `f` is features per meter. */
function noise3(x, y, z, f) {
  x *= f; y *= f; z *= f;
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(x - xi); const v = s(y - yi); const w = s(z - zi);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w,
  );
}
/** 1 at the centre of each stripe, 0 between; `width` is the fraction of the period that is dark. */
const band = (t, width) => 1 - smooth((Math.abs(fract(t) - 0.5) - width * 0.5 + 0.08) / 0.16);

const C = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, new THREE.Color(v)]));
const _out = new THREE.Color();
/** Final fur colour: base/light mix, then stripes, then fine grain so it does not look flat. */
function furColor(x, y, z, { lightness = 0, cream = 0, stripe = 0 }) {
  const grain = noise3(x, y, z, 420);
  const tuft = noise3(x, y, z, 90);
  _out.copy(C.base).lerp(C.light, Math.min(1, lightness + 0.25 * tuft));
  _out.lerp(C.cream, Math.min(1, cream));
  _out.lerp(stripe > 0.6 ? C.deep : C.dark, Math.min(1, stripe) * 0.85);
  const g = 0.9 + 0.18 * grain;
  return _out.setRGB(Math.min(1, _out.r * g), Math.min(1, _out.g * g), Math.min(1, _out.b * g));
}

const HEAD_C = new THREE.Vector3(0, BODY_Y + 0.105, 0.1);

function bodyFur(x, y, z) {
  const n = noise3(x, y, z, 40);
  const belly = smooth((0.085 - y) / 0.05);
  const chest = smooth((z - 0.06) / 0.05) * smooth((0.2 - y) / 0.05);
  // Mackerel stripes: vertical bands that lean back toward the rump, like the reference sheets.
  const t = (z + 0.18 * (y - BODY_Y)) / 0.038 + 0.3 * n + 0.12 * Math.sin(y * 70);
  const fade = smooth((y - 0.07) / 0.05) * (1 - chest);
  const spine = (1 - smooth((Math.abs(x) - 0.006) / 0.02)) * smooth((y - 0.19) / 0.02) * (1 - chest);
  return furColor(x, y, z, {
    lightness: 0.15 + 0.6 * belly,
    cream: 0.8 * chest,
    stripe: Math.max(band(t, 0.42) * fade, spine * 0.9),
  });
}

function legFur(x, y, z) {
  const n = noise3(x, y, z, 50);
  const paw = smooth((0.03 - y) / 0.02);
  return furColor(x, y, z, {
    lightness: 0.35 + 0.5 * paw,
    stripe: band(y / 0.03 + 0.3 * n, 0.4) * (1 - paw) * 0.9,
  });
}

function headFur(x, y, z) {
  const lx = x - HEAD_C.x; const ly = y - HEAD_C.y; const lz = z - HEAD_C.z;
  const n = noise3(x, y, z, 55);
  const front = smooth((lz - 0.02) / 0.04);
  const top = smooth((ly - 0.015) / 0.03);
  // Forehead: thin lines running front to back (the "M"), converging toward the brow.
  const forehead = band(lx / (0.02 + 0.08 * Math.max(0, ly)) + 0.5 + 0.15 * n, 0.3) * top * smooth((lz + 0.03) / 0.04);
  // Back and sides of the head: horizontal bands that continue the neck stripes.
  const back = band(ly / 0.03 + 0.25 * n, 0.38) * (1 - front) * (1 - top * 0.6);
  // Cheek line running back from the outer eye corner.
  const cheekLine = band((ly + 0.012) / 0.05 + 0.5, 0.18) * smooth((Math.abs(lx) - 0.06) / 0.02) * smooth((lz + 0.01) / 0.03);
  const muzzle = front * smooth((-0.012 - ly) / 0.02) * (1 - smooth((Math.abs(lx) - 0.04) / 0.02));
  const chin = smooth((-0.06 - ly) / 0.02);
  return furColor(x, y, z, {
    lightness: 0.3 + 0.4 * smooth((-0.02 - ly) / 0.03),
    cream: 0.9 * Math.max(muzzle, chin),
    stripe: Math.max(forehead * 0.85, back, cheekLine * 0.7) * (1 - muzzle),
  });
}

/** Paint `geo` (already placed in `bone`'s local space) with fn in rig space. Bones have no rest rotation. */
function furOn(rig, bone, geo, fn) {
  rig.group.updateMatrixWorld(true);
  const o = bone.getWorldPosition(new THREE.Vector3());
  return colorize(geo, (x, y, z) => fn(x + o.x, y + o.y, z + o.z));
}

export default function createCreature() {
  const rig = new Rig();

  // ---------------------------------------------------------------- skeleton (meters, +Y up, faces +Z)
  const root = rig.bone('root');
  const body = rig.bone('body', root, [0, BODY_Y, 0]);
  const chest = rig.bone('chest', body); // breathing scales this one; legs, head and tail are not its children
  const head = rig.bone('head', body, [0, 0.105, 0.1]);
  const eyeL = rig.bone('eyeL', head, [0.042, 0.004, 0.078]);
  const eyeR = rig.bone('eyeR', head, [-0.042, 0.004, 0.078]);
  const earL = rig.bone('earL', head, [0.06, 0.058, -0.004]);
  const earR = rig.bone('earR', head, [-0.06, 0.058, -0.004]);

  const legs = {};
  for (const [tag, side, front] of [['FL', 1, true], ['FR', -1, true], ['BL', 1, false], ['BR', -1, false]]) {
    // Front shoulders sit inside the chest so the leg tops never show.
    const hip = front ? [side * 0.05, -0.035, 0.075] : [side * 0.055, -0.03, -0.08];
    const U = front ? FRONT_UPPER : HIND_UPPER;
    const socket = rig.bone(`socket${tag}`, body, hip);
    const upper = rig.bone(`upper${tag}`, socket);
    const lower = rig.bone(`lower${tag}`, upper, [0, -U, 0]);
    legs[tag] = { side, front, socket, upper, lower };
  }

  // A gentle upward J: each joint turns the chain by a small, even angle so the skin never folds.
  const tailOffsets = [[0, 0.03, -0.115], [0, 0.018, -0.04], [0, 0.034, -0.03], [0, 0.04, -0.018], [0, 0.04, -0.004], [0, 0.034, 0.008]];
  const tail = [];
  tailOffsets.forEach((p, i) => tail.push(rig.bone(`tail${i}`, i ? tail[i - 1] : body, p)));

  // ---------------------------------------------------------------- materials
  // Fine fur strands as a normal map: high-frequency noise stretched along v (sphere meridians run
  // top to bottom, so strands hang down the body). Albedo stays near white; colour is in the vertices.
  const furTex = proceduralTexture((u, v) => {
    const strands = fbm(u, v, 48, 5, 3) * 0.55 + fbm(u, v * 0.25 + u * 0.02, 96, 9, 2) * 0.45;
    const clump = fbm(u, v, 12, 13, 3);
    const h = 0.7 * strands + 0.3 * clump;
    const g = 0.88 + 0.12 * h;
    return { h, color: new THREE.Color(g, g, g) };
  }, { size: 256, repeat: [4, 3], normalStrength: 2.2 });

  const materials = {
    fur: new THREE.MeshPhysicalMaterial({
      map: furTex.albedo, normalMap: furTex.normal, normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.88, metalness: 0, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color('#bcae9f'),
    }),
    skin: new THREE.MeshPhysicalMaterial({ roughness: 0.55, metalness: 0, sheen: 0.4, sheenColor: new THREE.Color('#ffd9d4') }),
    eye: new THREE.MeshPhysicalMaterial({ roughness: 0.25, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }),
    glint: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 1.15, 1.15) }),
    whisker: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0 }),
  };

  // ---------------------------------------------------------------- body
  rig.part(chest, 'fur', furOn(rig, chest, blob(0.1, { scale: [0.95, 0.85, 1.3], width: 36, height: 26 }), bodyFur));
  rig.part(chest, 'fur', furOn(rig, chest, place(blob(0.072, { scale: [1.08, 1.05, 0.8], width: 28, height: 20 }), [0, 0.012, 0.085]), bodyFur));
  rig.part(chest, 'fur', furOn(rig, chest, place(blob(0.08, { scale: [1.05, 0.95, 0.9], width: 28, height: 20 }), [0, 0.0, -0.075]), bodyFur));

  // ---------------------------------------------------------------- legs and paws
  for (const { side, front, socket, upper, lower } of Object.values(legs)) {
    const U = front ? FRONT_UPPER : HIND_UPPER;
    const L = front ? FRONT_LOWER : HIND_LOWER;
    if (!front) {
      // Haunch: the round hip that makes the hind legs read from the side.
      rig.part(socket, 'fur', furOn(rig, socket, place(blob(0.052, { scale: [0.7, 1, 1.05], width: 24, height: 18 }), [side * 0.006, 0.004, 0]), bodyFur));
    }
    rig.part(upper, 'fur', furOn(rig, upper, limb(U, front ? 0.03 : 0.034, 0.027, { radial: 16, rings: 6, bulge: 0.12, flat: 1 }), legFur));
    rig.part(lower, 'fur', furOn(rig, lower, limb(L * 0.75, 0.027, 0.025, { radial: 16, rings: 6, bulge: 0.05, flat: 1 }), legFur));
    rig.part(lower, 'fur', furOn(rig, lower, place(blob(0.026, { scale: [1.02, 0.62, 1.25], width: 20, height: 14 }), [0, -L + 0.016, 0.009]), legFur));
  }

  // ---------------------------------------------------------------- tail: one soft-skinned plume
  rig.skin('fur', tail, (joints) => {
    const last = joints[joints.length - 1];
    const tip = last.clone().add(last.clone().sub(joints[joints.length - 2]).setLength(0.02));
    return skinnedTube([...joints, tip], [0.024, 0.032, 0.04, 0.047, 0.05, 0.046, 0.03], {
      perSeg: 8, radial: 22, flatten: 0.92,
      color: (v, s) => {
        // Rings that get closer toward the tip; the upper surface is a touch darker.
        const n = noise3(v * 0.5, s * 0.05, 0, 30);
        const stripe = band(v * 6.5 + 0.2 + 0.25 * n, 0.4) * smooth((v - 0.06) / 0.08);
        return furColor(v * 0.31, s * 0.02, v * 0.17, { lightness: 0.3 - 0.15 * s, stripe });
      },
    });
  });
  // Rounded plume end (the tube itself is open-ended); a dark tip like a ringed tabby tail.
  {
    const last = tail[tail.length - 1];
    const dir = new THREE.Vector3(...tailOffsets[tailOffsets.length - 1]).normalize();
    const cap = place(blob(0.034, { scale: [1, 0.9, 1], width: 22, height: 16 }), dir.multiplyScalar(0.01).toArray());
    rig.part(last, 'fur', colorize(cap, (x, y, z) => furColor(x, y, z, { lightness: 0.1, stripe: 0.35 + 0.5 * smooth((y - 0.005) / 0.02) })));
  }

  // ---------------------------------------------------------------- head
  const headParts = [
    // [radius, scale, position]
    [0.1, [1.05, 0.95, 0.95], [0, 0, 0]], // skull
    [0.046, [0.72, 0.78, 0.95], [0.06, -0.036, 0.006]], // cheek ruff L
    [0.046, [0.72, 0.78, 0.95], [-0.06, -0.036, 0.006]], // cheek ruff R
    [0.02, [1, 0.85, 0.9], [0.016, -0.034, 0.078]], // whisker pad L
    [0.02, [1, 0.85, 0.9], [-0.016, -0.034, 0.078]], // whisker pad R
    [0.018, [1.1, 0.8, 0.9], [0, -0.054, 0.07]], // chin
  ];
  for (const [r, s, p] of headParts) {
    rig.part(head, 'fur', furOn(rig, head, place(blob(r, { scale: s, width: 32, height: 24 }), p), headFur));
  }
  rig.part(head, 'skin', place(blob(0.0095, { scale: [1.35, 0.8, 0.85], width: 16, height: 10, color: PAL.nose }), [0, -0.018, 0.097]));

  // Eyes: big glossy dark-brown discs; the bone scale closes them for the blink.
  const eyeColor = (x, y, z) => {
    if (z < 0) return mix(PAL.deep, '#000000', 0.6);
    const d = Math.hypot(x, y + 0.08);
    const iris = mix('#5a3624', '#2a180f', smooth((0.95 - d) / 0.4) + 0.3 * smooth(y / 0.6));
    return d < 0.52 ? mix('#070404', '#120a08', d / 0.52) : iris;
  };
  for (const [bone, side] of [[eyeL, 1], [eyeR, -1]]) {
    rig.part(bone, 'eye', place(blob(0.03, { scale: [1, 1.08, 0.42], width: 28, height: 20, color: eyeColor }), [0, 0, 0], [0, side * 0.36, 0]));
    // Two catch-lights on the same (viewer's right, upper) side of both eyes, like the 2D art.
    rig.part(bone, 'glint', place(blob(0.0072, { scale: [1, 1.1, 0.4], width: 12, height: 8 }), [0.009 + side * 0.004, 0.011, 0.0122]));
    rig.part(bone, 'glint', place(blob(0.0032, { scale: [1, 1, 0.4], width: 10, height: 6 }), [-0.009 + side * 0.004, -0.01, 0.0122]));
  }

  // Ears: flattened cones tilted outward, pink inner cone sitting just in front of the outer one.
  for (const [bone, side] of [[earL, 1], [earR, -1]]) {
    const tilt = [-0.12, side * -0.12, side * -0.48];
    const outer = place(spike(0.068, 0.036, { bend: 0.05, radial: 16, rings: 6 }), [0, 0, 0], [0, 0, 0], [1, 1, 0.62]);
    place(outer, [0, 0, 0], tilt);
    rig.part(bone, 'fur', furOn(rig, bone, outer, (x, y, z) => {
      const c = headFur(x, y, z);
      return c.lerp(C.deep, 0.45 * smooth((y - HEAD_C.y - 0.1) / 0.03));
    }));
    const inner = place(spike(0.052, 0.025, { bend: 0.04, radial: 14, rings: 5,
      color: (t) => mix(PAL.light, PAL.pink, smooth(t * 2.2)).lerp(C.light, 0.5 * smooth((t - 0.7) / 0.3)) }),
    [0, 0.005, 0.013], [0, 0, 0], [1, 1, 0.22]);
    rig.part(bone, 'skin', place(inner, [0, 0, 0], tilt));
  }

  // Whiskers: three thin strands per side fanning out from the pads.
  for (const side of [1, -1]) {
    for (const [droop, yaw, len] of [[-0.12, 0.25, 0.07], [0.02, 0.38, 0.075], [0.16, 0.5, 0.065]]) {
      const w = limb(len, 0.0011, 0.0003, { radial: 5, rings: 4, bulge: 0, curve: 0.04 * side, color: '#f2eee8' });
      rig.part(head, 'whisker', place(w, [side * 0.026, -0.032 + droop * 0.04, 0.084], [0, side * yaw, side * (Math.PI / 2 + droop)]));
    }
  }

  // ---------------------------------------------------------------- poses
  const rest = {
    chest: { r: [0, 0, 0] },
    head: { r: [0, 0, 0] },
    eyeL: { r: [0, 0, 0] },
    eyeR: { r: [0, 0, 0] },
    earL: { r: [0, 0, 0] },
    earR: { r: [0, 0, 0] },
    ...Object.fromEntries(tail.map((b) => [b.name, { r: [0, 0, 0] }])),
  };

  /** 0 → open, 1 → shut. A quick close (≈0.12 s) and a slightly slower open. */
  const blink = (u) => {
    const d = (u - BLINK_AT) * IDLE; // seconds from the blink centre
    return d < 0 ? 1 - smooth(-d / 0.07) : 1 - smooth(d / 0.11);
  };

  const clips = {
    idle: {
      label: '待机（呼吸 + 眨眼）', duration: IDLE, loop: true,
      pose: (u) => {
        const p = clonePose(rest);
        // Breathing: two breaths per loop, ribcage widens and lifts a little.
        const b = wave(u, 2);
        p.chest.s = [1 + 0.022 * b, 1 + 0.03 * b, 1 + 0.008 * b];
        p.head.r = [0.025 * wave(u, 2, -0.8), 0.04 * wave(u, 1, 0.5), 0];
        // Blink: squash the eyeballs vertically; the skull fur closes over them like a lid.
        const shut = blink(u);
        const s = [1 + 0.05 * shut, 1 - 0.93 * shut, 1];
        p.eyeL.s = s;
        p.eyeR.s = s;
        // Lazy tail sway, delayed down the chain.
        tail.forEach((bone, i) => { p[bone.name].r = [0.03 * wave(u, 1, -0.6 * i), 0.1 * wave(u, 1, -0.7 * i), 0]; });
        // Tiny ear flick right after the blink.
        const flick = Math.max(0, wave(u * 1 - BLINK_AT + 0.25, 1)) ** 12;
        p.earL.r = [0, 0, -0.18 * flick];
        return p;
      },
    },
  };

  return {
    name: 'desktop-cat',
    title: '桌面小猫',
    rig,
    materials,
    rest,
    clips,
    checkBones: ['head', 'eyeL', 'earR', 'lowerFL', 'lowerBR', 'tail5'],
    facing: ['head', 'tail5'],
    preview: { background: '#2a2d33', stage: 'studio' },
    shading: { ao: 0.45, radius: 0.03, sky: 0.18, tint: 0.02, exclude: ['glint', 'eye', 'whisker'] },
    shots: [
      { clip: 'idle', t: 0.1, view: 'front' },
      { clip: 'idle', t: 0.1, view: 'side' },
      { clip: 'idle', t: 0.1, view: 'back' },
      { clip: 'idle', t: BLINK_AT, view: 'front' },
    ],
    meta: { heightMeters: 0.33, blinkSeconds: +(BLINK_AT * IDLE).toFixed(3) },
    notes: ['眨眼通过 eyeL/eyeR 的 Y 轴缩放实现（scale 轨道）。', '毛发光泽用 KHR_materials_sheen；不支持 sheen 的引擎会退化为普通粗糙材质。'],
  };
}
