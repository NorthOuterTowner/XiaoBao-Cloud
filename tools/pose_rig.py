"""
Small rigged motions on top of single drawn poses: breathing, a tail sway, an ear
flick, a happy bounce and a waving paw.

The generated sheets are good at poses and bad at motion -- an 8-frame "breathing"
sleep came back as eight slightly different cats, and the wave only flipped between
paw-up and paw-down. So each of these takes one drawn frame and moves it in code,
the same idea as tools/walk_rig.py but simpler: the motions are small, so instead of
cutting the cat into a mesh, most of them are a smooth displacement field over the
whole frame (each output pixel says where in the source it comes from). Only two
pieces are actually cut out, because they move across something else: the stand's
tail, which swings behind the head, and the waving paw, which swings over the face.

Every rig returns frames on the source frame plus `PAD` of margin, in the source
frame's own pixels; `build_assets.place_rigged` lines them up on the sprite canvas
exactly where the source frame itself would go. Every looping rig's frame 0 is the
untouched source, so handing over to and from the drawn animations does not jump.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

PAD = 48


@dataclass
class Rigged:
    """A rig's output: padded frames anchored on one source frame."""

    anchor_w: int
    anchor_h: int
    pad: int
    frames: list[np.ndarray]  # uint8 RGBA, (anchor_h + 2*pad, anchor_w + 2*pad)
    fps: float
    durations: list[float] | None = None
    extra: dict = field(default_factory=dict)


# =====================================================================================
# Helpers
# =====================================================================================


def premultiply(rgba: np.ndarray) -> np.ndarray:
    f = rgba.astype(np.float32) / 255.0
    f[..., :3] *= f[..., 3:4]
    return f


def unpremultiply(f: np.ndarray) -> np.ndarray:
    a = f[..., 3:4]
    rgb = np.where(a > 1e-4, f[..., :3] / np.maximum(a, 1e-4), 0.0)
    return np.clip(np.concatenate([rgb, a], 2) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def pad(rgba: np.ndarray, p: int = PAD) -> np.ndarray:
    h, w = rgba.shape[:2]
    out = np.zeros((h + 2 * p, w + 2 * p, 4), dtype=np.uint8)
    out[p:p + h, p:p + w] = rgba
    return out


def over(top: np.ndarray, under: np.ndarray) -> np.ndarray:
    return top + under * (1.0 - top[..., 3:4])


def smooth(edge0: float, edge1: float, v):
    """Smoothstep from 0 at edge0 to 1 at edge1 (either order)."""
    t = np.clip((np.asarray(v, dtype=np.float64) - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def bell(lo: float, hi: float, v):
    """0 outside [lo, hi], 1 at the middle, smooth in between."""
    mid = (lo + hi) / 2
    return smooth(lo, mid, v) * smooth(hi, mid, v)


def sample(img: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    """Output pixel (y, x) shows source (sy, sx). Premultiplied in, premultiplied out."""
    out = np.empty(sx.shape + (4,), dtype=np.float32)
    for c in range(4):
        out[..., c] = ndimage.map_coordinates(img[..., c], [sy, sx], order=1,
                                              mode="constant", cval=0.0)
    return out


def rotate_back(X, Y, pivot, angle_deg, weight):
    """Source coords for a rotation of `angle_deg` (clockwise on screen) about
    `pivot`, applied with per-pixel strength `weight` -- a weight that grows away
    from the pivot bends the piece instead of turning it rigidly."""
    a = -np.radians(angle_deg) * weight
    c, s = np.cos(a), np.sin(a)
    dx, dy = X - pivot[0], Y - pivot[1]
    return pivot[0] + c * dx - s * dy, pivot[1] + s * dx + c * dy


def poly_mask(shape, poly, offset: float) -> np.ndarray:
    img = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).polygon([(x + offset, y + offset) for x, y in poly], fill=255)
    return np.asarray(img) > 127


def keyframes(keys: list[tuple[float, float]], t: float) -> float:
    """Piecewise-smooth interpolation through (time, value) keys."""
    xs, ys = zip(*keys)
    if t <= xs[0]:
        return ys[0]
    for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
        if t <= x1:
            u = (t - x0) / (x1 - x0)
            return y0 + (y1 - y0) * (u * u * (3 - 2 * u))
    return ys[-1]


def grid(shape):
    Y, X = np.mgrid[0:shape[0], 0:shape[1]].astype(np.float64)
    return X, Y


def breath(t: float) -> float:
    """0 at t=0 (exhaled, the drawn pose), 1 at mid-cycle."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * t)


def breathe_back(X, Y, p, b, *, cx, chest, widen, lift, lift_top, ground):
    """Source coords for a breath of strength `b` (0..1).

    The chest widens about `cx` by `widen` (a fraction) across the `chest` rows, and
    everything above `lift_top` rises by `lift` px, fading to nothing at `ground` so
    the paws stay planted."""
    w = bell(chest[0] + p, chest[1] + p, Y)
    k = 1.0 + widen * b * w
    sx = (cx + p) + (X - (cx + p)) / k
    sy = Y + lift * b * smooth(ground + p, lift_top + p, Y)
    return sx, sy


# =====================================================================================
# Rigs
# =====================================================================================


def rig_sit(src: np.ndarray) -> Rigged:
    """The resting front sit: a slow breath, a flick of the tail tip early in it and
    of the right ear late in it.

    tilt f0, 191x222. Chest across rows 95-215, ears based around row 40."""
    p, n, fps = PAD, 24, 8.0
    img = premultiply(pad(src, p))
    X, Y = grid(img.shape[:2])
    # The cat's right ear, the one on screen right: tip (140, 0), base (105-150, 38).
    ear_w = smooth(44 + p, 22 + p, Y) * bell(96 + p, 166 + p, X)
    ear_keys = [(0.0, 0.0), (14, 0.0), (15, -9.0), (16, 4.0), (17.5, 0.0), (n, 0.0)]
    # The tail, curled on the floor at the bottom right, root under the haunch at
    # (152, 205): its tip lifts and drops once, early in the breath.
    tail_w = smooth(150 + p, 186 + p, X) * smooth(160 + p, 176 + p, Y)
    tail_keys = [(0.0, 0.0), (4, 0.0), (5, -10.0), (6, -15.0), (7.5, -5.0), (9, 0.0),
                 (n, 0.0)]
    frames = []
    for k in range(n):
        b = breath(k / n)
        sx, sy = breathe_back(X, Y, p, b, cx=95, chest=(95, 222), widen=0.03,
                              lift=2.4, lift_top=110, ground=222)
        a = keyframes(ear_keys, k)
        if a:
            sx, sy = rotate_back(sx, sy, (128 + p, 40 + p), a, ear_w)
        a = keyframes(tail_keys, k)
        if a:
            sx, sy = rotate_back(sx, sy, (152 + p, 205 + p), a, tail_w)
        frames.append(unpremultiply(sample(img, sx, sy)) if k else pad(src, p))
    return Rigged(src.shape[1], src.shape[0], p, frames, fps)


# The stand's tail, stand f7 (291x344): it stands up on screen right behind the head,
# separated from it by the dark outline from (186,78) down to (200,140); below that it
# runs into the haunch. Cut on that outline, so the head stays in front of it.
STAND_TAIL = ((182, 80), (190, 52), (200, 30), (225, 12), (291, 0), (291, 240),
              (262, 240), (262, 205), (205, 205), (200, 140), (196, 110), (191, 88))


def rig_stand(src: np.ndarray) -> Rigged:
    """Standing front-on: a smaller breath, and the tail swaying once a cycle."""
    p, n, fps = PAD, 16, 8.0
    img = premultiply(pad(src, p))
    shape = img.shape[:2]
    X, Y = grid(shape)
    m = poly_mask(shape, STAND_TAIL, p)[..., None]
    tail, body = img * m, img * ~m
    # When the tail swings out, what was behind its edge next to the head is the
    # cat's back, not air. The unmoved tail's head-side strip stands in for it, so
    # no slit opens; its far side is left out, or a swing towards the head would
    # leave a ghost edge on the right.
    backing = tail * smooth(238 + p, 214 + p, X)[..., None]
    # Bends from the root up: nothing moves below row 200, the top of it most.
    bend = smooth(205 + p, 120 + p, Y)
    frames = [pad(src, p)]
    for k in range(1, n):
        t = k / n
        # Further into the head (left, hidden) than away from it, where a gap opens.
        s = math.sin(2 * math.pi * t)
        a = 2.2 * s if s > 0 else 4.0 * s
        tx, ty = rotate_back(X, Y, (232 + p, 215 + p), a, bend)
        acc = over(body, over(sample(tail, tx, ty), backing))
        sx, sy = breathe_back(X, Y, p, breath(t), cx=100, chest=(160, 330), widen=0.012,
                              lift=1.1, lift_top=175, ground=340)
        frames.append(unpremultiply(sample(acc, sx, sy)))
    return Rigged(src.shape[1], src.shape[0], p, frames, fps)


def rig_sleep(src: np.ndarray, *, back=(70, 170), ear_x=(118, 205),
              ear_rows=(90, 55), ear_pivot=(160, 88)) -> Rigged:
    """Curled up asleep: the back slowly rising and falling, one ear twitch.

    The curl faces left. The head is the left third and stays nearly still; the back
    (the top of the ball, weighted from `back[0]` to `back[1]` across) does the
    breathing. The defaults are for the old sleep f3; the lie_down sheet's last frame
    passes its own ear position."""
    p, n, fps = PAD, 16, 4.0
    h = src.shape[0]
    img = premultiply(pad(src, p))
    X, Y = grid(img.shape[:2])
    rise = smooth(h + p, 40 + p, Y) * (0.25 + 0.75 * smooth(back[0] + p, back[1] + p, X))
    # The upright ear on top of the head, fading out below its base row.
    ear_w = smooth(ear_rows[0] + p, ear_rows[1] + p, Y) * bell(ear_x[0] + p, ear_x[1] + p, X)
    ear_keys = [(0.0, 0.0), (10, 0.0), (10.6, 8.0), (11.4, -3.0), (12.4, 0.0), (n, 0.0)]
    frames = [pad(src, p)]
    for k in range(1, n):
        b = breath(k / n)
        cx = src.shape[1] * 0.58 + p
        sx = cx + (X - cx) / (1.0 + 0.022 * b * smooth(back[0] + p, back[1] + p, X))
        sy = Y + 6.0 * b * rise
        a = keyframes(ear_keys, k)
        if a:
            sx, sy = rotate_back(sx, sy, (ear_pivot[0] + p, ear_pivot[1] + p), a, ear_w)
        frames.append(unpremultiply(sample(img, sx, sy)))
    return Rigged(src.shape[1], src.shape[0], p, frames, fps)


def rig_happy(src: np.ndarray) -> Rigged:
    """Two happy hops on the spot, squashing and stretching, head rocking side to side.

    front f3, 305x357: eyes shut in happy arcs, sitting. Starts and ends on it."""
    p, fps = PAD, 14.0
    img = premultiply(pad(src, p))
    X, Y = grid(img.shape[:2])
    g, cx = 357 + p, 152 + p
    head_w = smooth(255 + p, 175 + p, Y)
    # (squash y, squash x, lift px) per frame of one hop; squash about the ground.
    hop = [(1.00, 1.00, 0), (0.94, 1.03, 0), (1.05, 0.98, 6), (1.02, 0.99, 15),
           (1.00, 1.00, 18), (1.02, 0.99, 10), (0.93, 1.04, 0), (0.98, 1.01, 0)]
    poses = hop + hop + [(1.00, 1.00, 0)]
    frames = []
    for k, (sy_, sx_, lift) in enumerate(poses):
        if k in (0, len(poses) - 1):
            frames.append(pad(src, p))
            continue
        # Undo the squash and lift, then the head rock.
        ux = cx + (X - cx) / sx_
        uy = g + (Y + lift - g) / sy_
        a = 6.0 * math.sin(2 * math.pi * k / 8)
        ux, uy = rotate_back(ux, uy, (152 + p, 240 + p), a, head_w)
        frames.append(unpremultiply(sample(img, ux, uy)))
    return Rigged(src.shape[1], src.shape[0], p, frames, fps)


# The waving paw in run f4 (293x376): pad and forearm inside their own outline --
# toes along row ~148, the paw's left edge at x~9, its right at x~80 -- joining the
# body at the elbow below row 260. The cheek fur left of and above it stays put.
WAVE_PAW = ((14, 160), (24, 150), (45, 144), (70, 146), (82, 150), (84, 215),
            (82, 280), (4, 280), (5, 235), (8, 200), (9, 172))


def align(ref: np.ndarray, other: np.ndarray, rows=(0, 140), cols=(90, 250), r=14):
    """Integer (dx, dy) to paste `other` at so its head lands on `ref`'s."""
    a = ref[rows[0]:rows[1], cols[0]:cols[1]].astype(np.float32)
    best = None
    for dy in range(-6, 7):
        for dx in range(-r, r + 1):
            y0, x0 = rows[0] - dy, cols[0] - dx
            if y0 < 0 or x0 < 0:
                continue
            b = other[y0:y0 + a.shape[0], x0:x0 + a.shape[1]].astype(np.float32)
            if b.shape != a.shape:
                continue
            e = np.abs(a - b).mean()
            if best is None or e < best[0]:
                best = (e, dx, dy)
    return best[1], best[2]


def paste(rgba: np.ndarray, shape, dx: int, dy: int, p: int) -> np.ndarray:
    out = np.zeros(shape + (4,), dtype=np.uint8)
    h, w = rgba.shape[:2]
    out[p + dy:p + dy + h, p + dx:p + dx + w] = rgba
    return out


def rig_wave(raised: np.ndarray, half: np.ndarray, neutral: np.ndarray) -> Rigged:
    """Raise a paw, wave it side to side twice, put it down.

    The raise and lower are the drawn frames (neutral run f7, halfway run f5, up
    run f4), lined up on run f4's head so the body no longer shuffles sideways as
    the paw goes up. The waving itself is run f4's paw cut out and swung about the
    elbow, over the face fur from the neutral frame."""
    p = PAD
    shape = (raised.shape[0] + 2 * p, raised.shape[1] + 2 * p)
    up = pad(raised, p)
    mid = paste(half, shape, *align(raised, half), p)
    rest = paste(neutral, shape, *align(raised, neutral), p)

    m = poly_mask(shape, WAVE_PAW, p)[..., None]
    up_f, rest_f = premultiply(up), premultiply(rest)
    paw = up_f * m
    # Under the paw, the neutral frame's fur, faded in over a few px so its edge does
    # not show as a hard-edged block when the paw swings off it.
    soft = np.clip(ndimage.gaussian_filter(m[..., 0].astype(np.float32), 4.0) * 1.6 - 0.3,
                   0.0, 1.0)[..., None] * m
    under = up_f * (1 - soft) + rest_f * soft
    X, Y = grid(shape)
    bend = smooth(278 + p, 215 + p, Y)

    swings = []
    for k in range(1, 12):
        # Out, away from the face, further than back in over it.
        s = math.sin(2 * math.pi * k / 6)
        a = -12.0 * s if s > 0 else -6.0 * s
        sx, sy = rotate_back(X, Y, (42 + p, 292 + p), a, bend)
        swings.append(unpremultiply(over(sample(paw, sx, sy), under)))

    frames = [rest, mid, up, *swings, up, mid, rest]
    durations = [0.12, 0.10, 0.08] + [0.07] * len(swings) + [0.08, 0.10, 0.14]
    return Rigged(raised.shape[1], raised.shape[0], p, frames,
                  fps=len(frames) / sum(durations), durations=durations)


def align_bottom(ref: np.ndarray, other: np.ndarray, band: int = 110, r: int = 10):
    """(dx, dy) to paste `other` at, relative to `ref`'s top-left, so their lower
    bodies (haunches and paws on the ground) line up. Heads are left free -- they are
    what moves between these frames."""
    rh, rw = ref.shape[:2]
    oh, ow = other.shape[:2]
    a = ref[rh - band:rh, 20:rw - 20, 3].astype(np.float32)
    best = None
    for dy in range(-6, 7):
        for dx in range(-r, r + 1):
            # Row rh-band of ref corresponds to row (rh-band) - (rh-oh+dy) of other.
            y0 = rh - band - (rh - oh + dy)
            x0 = 20 - dx
            if y0 < 0 or x0 < 0 or y0 + band > oh or x0 + a.shape[1] > ow:
                continue
            b = other[y0:y0 + band, x0:x0 + a.shape[1], 3].astype(np.float32)
            e = np.abs(a - b).mean()
            if best is None or e < best[0]:
                best = (e, dx, rh - oh + dy)
    if best is None:
        return 0, rh - oh
    return best[1], best[2]


# Groom, front f4 (303x379): the raised paw to the left of the chest, toes along row
# ~250, its top at row ~195; the forearm runs down into the chest below row 262.
GROOM_PAW = ((34, 225), (40, 205), (55, 195), (85, 193), (102, 203), (108, 222),
             (106, 262), (104, 300), (42, 300), (36, 262))


def rig_groom(neutral: np.ndarray, raised: np.ndarray, near: np.ndarray,
              lick: np.ndarray) -> Rigged:
    """Sit, lift a paw, lick it a few times, put it back down, sit.

    Drawn frames: neutral sit (front f0), paw raised (f4), paw at the mouth (f5),
    licking (f6). All are lined up on f4's lower body, so the haunches and paws stop
    shuffling between frames. The lift and the lowering get two rigged in-betweens --
    f4's paw slid down towards the floor over the neutral frame's chest fur -- and
    the lick is a loop on f6: the paw strokes up against the tongue while the head
    dips into it, three times."""
    p = PAD
    shape = (raised.shape[0] + 2 * p, raised.shape[1] + 2 * p)
    up = pad(raised, p)
    rest = paste(neutral, shape, *align_bottom(raised, neutral), p)
    mid = paste(near, shape, *align_bottom(raised, near), p)
    lk = paste(lick, shape, *align_bottom(raised, lick), p)
    X, Y = grid(shape)

    # ---- the lift: f4's paw lowered by 2/3 and 1/3 of the way to the floor -------
    up_f, rest_f = premultiply(up), premultiply(rest)
    m = poly_mask(shape, GROOM_PAW, p)[..., None]
    soft = np.clip(ndimage.gaussian_filter(m[..., 0].astype(np.float32), 4.0) * 1.6 - 0.3,
                   0.0, 1.0)[..., None] * m
    under = up_f * (1 - soft) + rest_f * soft
    paw = up_f * m
    # The paw moves most, the forearm's root at the elbow hardly at all.
    reach = smooth(322 + p, 205 + p, Y)
    lowered = []
    for d in (34.0, 17.0):
        layer = sample(paw, X, Y - d * reach)
        lowered.append(unpremultiply(over(layer, under)))

    # ---- the lick loop on f6 ------------------------------------------------------
    lk_f = premultiply(lk)
    # Offsets of f6 inside the padded frame, so its own coordinates can be used.
    dx6, dy6 = align_bottom(raised, lick)
    ox, oy = p + dx6, p + dy6
    paw_w = bell(28 + ox, 125 + ox, X) * bell(165 + oy, 275 + oy, Y)
    head_w = smooth(215 + oy, 160 + oy, Y)
    licks = []
    for k in range(6):
        s = math.sin(2 * math.pi * k / 6)
        up_px = 5.0 * max(s, 0.0) + 1.5 * min(s, 0.0)
        sx, sy = X, Y + up_px * paw_w
        # The head dips into the stroke and tips slightly towards the paw.
        sy = sy - 2.0 * max(s, 0.0) * head_w
        sx, sy = rotate_back(sx, sy, (150 + ox, 230 + oy), -2.0 * max(s, 0.0), head_w)
        licks.append(unpremultiply(sample(lk_f, sx, sy)) if k else lk)

    frames = [rest, lowered[0], lowered[1], up, mid, *(licks * 3), mid, up,
              lowered[1], lowered[0], rest]
    durations = ([0.22, 0.07, 0.07, 0.12, 0.14] + [0.075] * 18
                 + [0.12, 0.12, 0.07, 0.07, 0.24])
    return Rigged(raised.shape[1], raised.shape[0], p, frames,
                  fps=len(frames) / sum(durations), durations=durations)


def rig_chew(frames_src: list[np.ndarray], order: list[int]) -> Rigged:
    """Jaw working on a mouthful, the head nodding with it.

    The drawn chew frames (chew sheet, 331x366-ish, chin at row ~180) only move the
    jaw. Each is lined up on the first one's lower body, then the head is pushed
    down a few px on every closed-jaw frame and lifted a touch on the open ones, with
    a half-way frame in between so the nod reads as motion rather than a hop."""
    p = PAD
    ref = frames_src[order[0]]
    shape = (ref.shape[0] + 2 * p, ref.shape[1] + 2 * p)
    X, Y = grid(shape)
    placed = {}
    for i in set(order):
        dx, dy = align_bottom(ref, frames_src[i]) if i != order[0] else (0, 0)
        placed[i] = (premultiply(paste(frames_src[i], shape, dx, dy, p)), dy)

    # Closed jaw (the cheeks-full frame, sheet f2) nods down; the others lift.
    def nod(i):
        return 3.5 if i == 2 else -1.0

    out = []
    for a, b in zip(order, order[1:] + order[:1]):
        for half in (0.0, 0.5):
            img, dy = placed[a]
            n = nod(a) * (1 - half) + nod(b) * half if half else nod(a)
            head_w = smooth(240 + p + dy, 170 + p + dy, Y)
            out.append(unpremultiply(sample(img, X, Y - n * head_w)))
    return Rigged(ref.shape[1], ref.shape[0], p, out, fps=14.0)
