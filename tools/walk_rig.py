"""
The walk cycle, built in code from one side-on standing pose.

Image models cannot draw a gait. Asked for a frame-by-frame walk they draw the same
"cat walking" pose over and over -- on every sheet tried, one hind leg stayed back,
the other stayed forward, and the front paws only flipped between up and down. So
the walk is not drawn at all. It is rigged:

  * The source is the turn sheet's f7, the left profile stand. It is the last frame
    of turn_left and the first of face_front_from_left, so the walk shares its body
    pixel for pixel with the animations either side of it.
  * The two near legs are cut out of it along their own outlines. The two far legs
    are removed from the body and replaced by darkened copies of the near legs,
    drawn behind the body, so no leg ever has a hole where another used to cover it.
  * Every leg's top is glued to the body. Below that the leg is a mesh bent along a
    spine: the upper leg leans and squashes, the paw is rigid and tilts at the wrist.
    Leg poses come from the gait, solved so the paw lands exactly where it should.
  * The gait is a cat's slow walk, a four-beat lateral sequence: left hind, left
    front, right hind, right front, a quarter cycle apart. Each paw lifts, swings
    forward, sets down and then stays planted, sliding back under the body at exactly
    the speed the cat moves forward (`GROUND_SPEED`), so it never skates.

Coordinates are the source frame's own pixels: x right, y down, the cat faces -x.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, optimize

# ---- gait ---------------------------------------------------------------------------

FRAMES = 16
FPS = 24.0
# Fraction of the cycle each paw spends in the air: 6 of 16 frames. A walk keeps at
# least two paws down at all times, which needs this under a half.
SWING = 6 / FRAMES
# Half the distance a planted paw travels back under the body, in source px.
STRIDE = 20.0
# How far a planted paw moves per second. This *is* the walking speed: the app has
# to move the cat at exactly this rate (scaled to screen pixels) or the feet skate.
GROUND_SPEED = (2 * STRIDE / (FRAMES * (1 - SWING))) * FPS
# Body bob, source px, twice per cycle (once per pair of footfalls).
BOB = 1.3

# Transparent margin around the source, so a leg reaching forward or back is never
# clipped. Callers place frames knowing this.
PAD = 48

# Rows above a leg's cut that the leg piece repeats, so the joint is never a seam.
OVERLAP = 4


@dataclass(frozen=True)
class LegSpec:
    name: str
    # Outline of the piece, source px. Intersected with the source alpha, so it only
    # has to be exact where it runs through the cat.
    poly: tuple[tuple[float, float], ...]
    top: float  # cut row; above it the piece is glued to the body
    wrist: float  # rows below this are the rigid paw
    ground: float  # lowest paw row at rest
    phase: float  # gait offset, fraction of a cycle
    lift: float  # swing height, source px
    # Paw tilt in degrees through the swing (u = 0..1) and the stance (v = 0..1).
    # Negative lifts the heel: the paw tips forward onto its toes.
    swing_tilt: tuple[tuple[float, float], ...]
    stance_tilt: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class CloneSpec:
    """A far leg: a near leg's piece, shaded and drawn behind the body."""

    name: str
    of: str
    dx: float  # offset of the whole leg from the near one it copies
    dy: float  # negative = higher; the far paw stands further up the screen
    shade: float
    phase: float


# Paw tilt: toe-off at the end of the stance, the paw curled back as it comes up,
# then reaching forward with the toes up just before it sets down flat.
# Kept small: the chibi paw is wider than it is tall, so tipping it forward drops its
# toes by half its width times the sine of the tilt, eating into the lift.
FRONT_SWING_TILT = ((0.0, -10.0), (0.3, -12.0), (0.62, -2.0), (0.86, 9.0), (1.0, 0.0))
HIND_SWING_TILT = ((0.0, -8.0), (0.3, -9.0), (0.62, -1.0), (0.86, 7.0), (1.0, 0.0))
FRONT_STANCE_TILT = ((0.0, 0.0), (0.75, 0.0), (1.0, -10.0))
HIND_STANCE_TILT = ((0.0, 0.0), (0.75, 0.0), (1.0, -8.0))

# Read off turn f7 at 6x. The near front leg's left outline runs from (113,260) to
# (125,300); its right one from (190,265) to (180,302). The near hind leg's front
# outline is the diagonal from (260,253) to (300,295); its back is the rump line at
# x~357. Each polygon keeps the leg's own outline and stops short of the leg behind.
NEAR_FRONT = LegSpec(
    "near_front",
    poly=((108, 258), (197, 258), (197, 263), (193, 266), (191, 272), (189, 279),
          (187, 286), (185, 293), (184, 300), (188, 345), (112, 345), (115, 304),
          (120, 302), (123, 297), (121, 289), (119, 280), (118, 272), (115, 266),
          (108, 262)),
    top=262, wrist=310, ground=333,
    phase=0.25, lift=18.0,
    swing_tilt=FRONT_SWING_TILT, stance_tilt=FRONT_STANCE_TILT,
)
NEAR_HIND = LegSpec(
    "near_hind",
    poly=((262, 258), (366, 258), (366, 345), (289, 345), (290, 310), (293, 303),
          (296, 299), (297, 293), (294, 287), (290, 282), (285, 278), (280, 274),
          (275, 270), (270, 267), (265, 262)),
    top=266, wrist=305, ground=326,
    phase=0.0, lift=14.0,
    swing_tilt=HIND_SWING_TILT, stance_tilt=HIND_STANCE_TILT,
)
NEAR_LEGS = (NEAR_HIND, NEAR_FRONT)

# Lateral sequence: left hind 0, left front 1/4, right hind 1/2, right front 3/4.
# The cat faces left, so the near legs are its left ones. The far paws stand ~9px
# higher, as the source's own far paws do (324 vs 333 front, 316 vs 326 hind).
FAR_LEGS = (
    CloneSpec("far_hind", "near_hind", dx=-2.0, dy=-10.0, shade=0.70, phase=0.5),
    CloneSpec("far_front", "near_front", dx=-3.0, dy=-9.0, shade=0.70, phase=0.75),
)

# The source's own far legs, taken off the body. Their tops follow the chest's and
# the belly's lower outline, which stays on the body.
FAR_REMOVE = (
    ((48, 240), (68, 240), (75, 243), (80, 247), (85, 251), (90, 254), (95, 257),
     (100, 260), (105, 262), (110, 264), (116, 266), (128, 266), (128, 345), (48, 345)),
    ((232, 268), (242, 266), (250, 264), (258, 263), (263, 261), (268, 264),
     (273, 268), (278, 271), (283, 275), (288, 280), (293, 285), (296, 291),
     (297, 296), (294, 302), (291, 310), (290, 345), (232, 345)),
)

OUTLINE_RGB = np.array([46.0, 36.0, 38.0])


# =====================================================================================
# Pieces
# =====================================================================================


def _poly_mask(shape: tuple[int, int], poly, dy: float = 0.0, dx: float = 0.0) -> np.ndarray:
    img = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).polygon([(x + dx, y + dy) for x, y in poly], fill=255)
    return np.asarray(img) > 127


def _premultiply(rgba: np.ndarray) -> np.ndarray:
    f = rgba.astype(np.float32) / 255.0
    f[..., :3] *= f[..., 3:4]
    return f


def _unpremultiply(f: np.ndarray) -> np.ndarray:
    a = f[..., 3:4]
    rgb = np.where(a > 1e-4, f[..., :3] / np.maximum(a, 1e-4), 0.0)
    out = np.concatenate([rgb, a], axis=2)
    return np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _over(top: np.ndarray, under: np.ndarray) -> np.ndarray:
    return top + under * (1.0 - top[..., 3:4])


def _interp(keys: tuple[tuple[float, float], ...], t: float) -> float:
    xs, ys = zip(*keys)
    return float(np.interp(t, xs, ys))


class Leg:
    """One leg piece and how to bend it."""

    def __init__(self, spec: LegSpec, src: np.ndarray):
        self.spec = spec
        h, w = src.shape[:2]
        # Pad by PAD everywhere, so the spec's source-px numbers shift by PAD.
        p = PAD
        self.top = spec.top + p
        self.wrist = spec.wrist + p
        self.ground = spec.ground + p
        self.len_upper = self.wrist - self.top

        piece = _poly_mask((h, w), spec.poly, dx=p, dy=p)
        piece &= np.arange(h)[:, None] >= self.top - OVERLAP
        self.mask = piece
        self.img = src * piece[..., None]

        ys, xs = np.nonzero(piece & (src[..., 3] > 0.02))
        self.box = (xs.min(), ys.min(), xs.max(), ys.max())
        row = src[int(self.top), :, 3] * piece[int(self.top)]
        self.x_ref = float((row * np.arange(w)).sum() / max(row.sum(), 1e-6))

        # The paw's solid pixels relative to the wrist, for finding its lowest point
        # at any tilt; and its bottom-centre, the point that tracks the ground.
        paw = piece & (src[..., 3] > 0.5) & (np.arange(h)[:, None] > self.wrist)
        py, px = np.nonzero(paw)
        self.paw_pts = np.stack([px - self.x_ref, py - self.wrist], axis=1).astype(np.float64)
        bottom = py >= py.max() - 1
        self.foot = np.array([px[bottom].mean() - self.x_ref, py.max() - self.wrist])
        # Stand on the paw's real lowest pixel, so the rest pose is exactly the source.
        self.ground = float(py.max())
        if abs(self.ground - (spec.ground + p)) > 2:
            raise RuntimeError(
                f"{spec.name}: paw bottom is row {self.ground - p:.0f}, spec says "
                f"{spec.ground:.0f} -- the polygon is not around the leg it names"
            )

        self.grid = self._grid()

    # ---- the bend -------------------------------------------------------------------

    def _alpha(self, t: np.ndarray, beta: float, theta: float) -> np.ndarray:
        """Spine angle along the upper leg, t = 0 at the cut, 1 at the wrist.

        Starts upright so the glued top stays glued, leans by `beta` mostly in the
        upper part, and turns to the paw's own tilt `theta` approaching the wrist, so
        the paw joins the leg without a kink."""
        g1 = 1.0 - (1.0 - t) ** 3
        s = np.clip((t - 0.7) / 0.3, 0.0, 1.0)
        g2 = s * s * (3 - 2 * s)
        return beta * g1 + (theta - beta) * g2

    def _spine(self, beta: float, lam: float, theta: float, n: int = 96):
        t = np.linspace(0.0, 1.0, n)
        a = self._alpha(t, beta, theta)
        ds = lam * self.len_upper / (n - 1)
        dx = np.sin(a) * ds
        dy = np.cos(a) * ds
        x = np.concatenate([[0.0], np.cumsum((dx[1:] + dx[:-1]) / 2)])
        y = np.concatenate([[0.0], np.cumsum((dy[1:] + dy[:-1]) / 2)])
        return t, a, x, y

    @staticmethod
    def _rot(theta: float, v: np.ndarray) -> np.ndarray:
        # Same convention as the spine: +theta swings the downward direction to +x.
        c, s = math.cos(theta), math.sin(theta)
        return np.stack([c * v[..., 0] + s * v[..., 1], -s * v[..., 0] + c * v[..., 1]], -1)

    def solve(self, root: np.ndarray, foot_x: float, low_y: float, theta: float):
        """Lean and squash that put the paw's bottom-centre at `foot_x` and its lowest
        point on `low_y`, with the leg glued at `root`.

        The wrist is `root + lam * I(beta)`, where I is the unsquashed spine's end. So
        the direction of the wrist from the root fixes beta alone -- a 1-D root find
        that cannot wander -- and the distance then gives lam."""
        paw_low = self._rot(theta, self.paw_pts)[:, 1].max()
        foot = self._rot(theta, self.foot)
        want = np.array([foot_x - foot[0] - root[0], low_y - paw_low - root[1]])
        if want[1] <= 1.0:
            raise RuntimeError(f"{self.spec.name}: paw target is above the leg's own top")

        def end(beta):
            _, _, x, y = self._spine(beta, 1.0, theta)
            return x[-1], y[-1]

        def lean_err(beta):
            x, y = end(beta)
            return x * want[1] - y * want[0]

        lim = math.radians(80)
        beta = optimize.brentq(lean_err, -lim, lim, xtol=1e-9)
        x, y = end(beta)
        lam = float(np.hypot(*want) / np.hypot(x, y))
        if not (0.35 < lam < 1.25):
            raise RuntimeError(
                f"{self.spec.name}: paw target needs the leg squashed to {lam:.2f}; "
                f"lower the lift or the paw tilt"
            )
        return float(beta), lam

    # ---- mesh -----------------------------------------------------------------------

    def _grid(self, step: float = 2.0) -> np.ndarray:
        x0, y0, x1, y1 = self.box
        xs = np.arange(x0 - 3, x1 + 4, step, dtype=np.float64)
        ys = np.arange(min(y0, self.top - OVERLAP) - 2, y1 + 4, step, dtype=np.float64)
        # The cut and the wrist must be mesh rows, or a triangle would straddle them.
        ys = np.unique(np.concatenate([ys, [self.top, self.wrist]]))
        gx, gy = np.meshgrid(xs, ys)
        return np.stack([gx, gy], axis=-1)

    def warp(self, root_shift: np.ndarray, beta: float, lam: float, theta: float) -> np.ndarray:
        """Target position of every source mesh vertex."""
        src = self.grid
        X, Y = src[..., 0], src[..., 1]
        root = np.array([self.x_ref, self.top]) + root_shift
        e = X - self.x_ref
        out = np.empty_like(src)

        above = Y < self.top
        out[above] = src[above] + root_shift

        t_tab, a_tab, x_tab, y_tab = self._spine(beta, lam, theta)
        upper = (~above) & (Y <= self.wrist)
        t = (Y[upper] - self.top) / self.len_upper
        a = np.interp(t, t_tab, a_tab)
        px = root[0] + np.interp(t, t_tab, x_tab)
        py = root[1] + np.interp(t, t_tab, y_tab)
        out[upper, 0] = px + e[upper] * np.cos(a)
        out[upper, 1] = py - e[upper] * np.sin(a)

        paw = Y > self.wrist
        wrist = root + np.array([x_tab[-1], y_tab[-1]])
        rel = np.stack([e[paw], Y[paw] - self.wrist], -1)
        out[paw] = wrist + self._rot(theta, rel)
        return out


# =====================================================================================
# Rasterising a warped mesh
# =====================================================================================


def _rasterize(src_xy: np.ndarray, dst_xy: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Per output pixel, the source coordinate it shows; NaN where nothing lands.

    Triangles later in mesh order win where the mesh folds over itself, and mesh order
    runs top to bottom, so a paw tucked up against its own leg is drawn in front."""
    h, w = shape
    ny, nx = src_xy.shape[:2]
    i, j = np.meshgrid(np.arange(ny - 1), np.arange(nx - 1), indexing="ij")
    i, j = i.ravel(), j.ravel()
    a, b, c, d = (i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)
    tri = [(a, b, c), (a, c, d)]
    D = np.concatenate([np.stack([dst_xy[v] for v in t], 1) for t in tri])
    S = np.concatenate([np.stack([src_xy[v] for v in t], 1) for t in tri])
    order = np.concatenate([np.arange(len(i)) * 2, np.arange(len(i)) * 2 + 1])

    lo = np.floor(D.min(1)).astype(int)
    span = np.ceil(D.max(1)).astype(int) - lo
    k = int(span.max()) + 2
    off = np.arange(k)
    gx = lo[:, 0, None, None] + off[None, None, :]
    gy = lo[:, 1, None, None] + off[None, :, None]
    gx, gy = np.broadcast_arrays(gx, gy)

    p0 = D[:, 0]
    v0 = D[:, 1] - p0
    v1 = D[:, 2] - p0
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    good = np.abs(den) > 1e-9
    den = np.where(good, den, 1.0)
    qx = gx - p0[:, 0, None, None]
    qy = gy - p0[:, 1, None, None]
    l1 = (qx * v1[:, 1, None, None] - v1[:, 0, None, None] * qy) / den[:, None, None]
    l2 = (v0[:, 0, None, None] * qy - qx * v0[:, 1, None, None]) / den[:, None, None]
    l0 = 1.0 - l1 - l2
    eps = -1e-7
    inside = (l0 >= eps) & (l1 >= eps) & (l2 >= eps) & good[:, None, None]
    inside &= (gx >= 0) & (gx < w) & (gy >= 0) & (gy < h)

    t_idx = np.broadcast_to(np.arange(len(D))[:, None, None], inside.shape)[inside]
    sx = (l0[inside] * S[t_idx, 0, 0] + l1[inside] * S[t_idx, 1, 0] + l2[inside] * S[t_idx, 2, 0])
    sy = (l0[inside] * S[t_idx, 0, 1] + l1[inside] * S[t_idx, 1, 1] + l2[inside] * S[t_idx, 2, 1])
    pix = gy[inside] * w + gx[inside]
    pri = order[t_idx]

    # Highest priority per pixel wins.
    srt = np.lexsort((pri, pix))
    pix, sx, sy = pix[srt], sx[srt], sy[srt]
    last = np.ones(len(pix), dtype=bool)
    last[:-1] = pix[1:] != pix[:-1]

    out = np.full((h * w, 2), np.nan)
    out[pix[last], 0] = sx[last]
    out[pix[last], 1] = sy[last]
    return out.reshape(h, w, 2)


def _sample(img: np.ndarray, coords: np.ndarray) -> np.ndarray:
    covered = ~np.isnan(coords[..., 0])
    out = np.zeros(coords.shape[:2] + (4,), dtype=np.float32)
    if not covered.any():
        return out
    cy = coords[..., 1][covered]
    cx = coords[..., 0][covered]
    for ch in range(4):
        out[..., ch][covered] = ndimage.map_coordinates(
            img[..., ch], [cy, cx], order=1, mode="constant", cval=0.0
        )
    return out


# =====================================================================================
# The rig
# =====================================================================================


class WalkRig:
    def __init__(self, source_rgba: np.ndarray):
        h, w = source_rgba.shape[:2]
        self.src_size = (w, h)
        padded = np.zeros((h + 2 * PAD, w + 2 * PAD, 4), dtype=np.uint8)
        padded[PAD:PAD + h, PAD:PAD + w] = source_rgba
        src = _premultiply(padded)
        self.shape = src.shape[:2]

        self.legs = {spec.name: Leg(spec, src) for spec in NEAR_LEGS}

        # The body: everything except the legs below their cuts. Near legs cover their
        # own cuts at every pose (their tops never move); the far legs' cuts are open
        # to the background, so the new edge gets an outline drawn on.
        rows = np.arange(self.shape[0])[:, None]
        gone = np.zeros(self.shape, dtype=bool)
        for spec in NEAR_LEGS:
            m = _poly_mask(self.shape, spec.poly, dx=PAD, dy=PAD)
            gone |= m & (rows >= spec.top + PAD)
        far_gone = np.zeros(self.shape, dtype=bool)
        for poly in FAR_REMOVE:
            far_gone |= _poly_mask(self.shape, poly, dx=PAD, dy=PAD)
        far_gone &= ~gone
        gone |= far_gone

        body = src * (~gone)[..., None]
        cut_edge = far_gone & (src[..., 3] > 0.5)
        dist = ndimage.distance_transform_edt(~cut_edge)
        weight = np.clip(1.0 - (dist - 1.0) / 2.0, 0.0, 1.0) * 0.9
        weight *= body[..., 3] > 0.5
        rgb = body[..., :3] / np.maximum(body[..., 3:4], 1e-4)
        rgb = rgb * (1 - weight[..., None]) + (OUTLINE_RGB / 255.0) * weight[..., None]
        body[..., :3] = rgb * body[..., 3:4]
        self.body = body

    @staticmethod
    def _leg_pose(spec: LegSpec, phase: float) -> tuple[float, float, float]:
        """(forward offset of the paw, height off the ground, paw tilt deg)."""
        p = phase % 1.0
        if p < SWING:
            u = p / SWING
            fwd = -STRIDE + 2 * STRIDE * (u * u * (3 - 2 * u))
            up = spec.lift * math.sin(math.pi * u)
            tilt = _interp(spec.swing_tilt, u)
        else:
            v = (p - SWING) / (1 - SWING)
            fwd = STRIDE * (1 - 2 * v)
            up = 0.0
            tilt = _interp(spec.stance_tilt, v)
        return fwd, up, tilt

    def _render_leg(self, leg: Leg, shift: np.ndarray, ground_dy: float, fwd: float,
                    up: float, tilt_deg: float, shade: float = 1.0) -> np.ndarray:
        """`shift` moves where the leg is glued on (body bob, far-leg offset);
        `ground_dy` moves the floor it stands on (far-leg offset only -- the floor
        does not bob with the body)."""
        theta = math.radians(tilt_deg)
        root = np.array([leg.x_ref, leg.top]) + shift
        # The cat faces -x: forward is left.
        foot_x = leg.x_ref + leg.foot[0] + shift[0] - fwd
        low_y = leg.ground + ground_dy - up
        beta, lam = leg.solve(root, foot_x, low_y, theta)
        dst = leg.warp(shift, beta, lam, theta)
        coords = _rasterize(leg.grid, dst, self.shape)
        layer = _sample(leg.img, coords)
        if shade != 1.0:
            layer[..., :3] *= shade
        return layer

    def frame(self, k: int) -> np.ndarray:
        t = k / FRAMES
        bob = BOB * math.cos(4 * math.pi * t)
        acc = np.zeros(self.shape + (4,), dtype=np.float32)

        # Behind the body: the far legs, darker.
        for clone in FAR_LEGS:
            leg = self.legs[clone.of]
            fwd, up, tilt = self._leg_pose(leg.spec, clone.phase + t)
            shift = np.array([clone.dx, clone.dy + bob])
            acc = _over(self._render_leg(leg, shift, clone.dy, fwd, up, tilt, clone.shade), acc)

        body = ndimage.shift(self.body, (bob, 0, 0), order=1, mode="constant", cval=0.0)
        acc = _over(body, acc)

        for spec in NEAR_LEGS:
            leg = self.legs[spec.name]
            fwd, up, tilt = self._leg_pose(spec, spec.phase + t)
            acc = _over(self._render_leg(leg, np.array([0.0, bob]), 0.0, fwd, up, tilt), acc)

        return _unpremultiply(acc)

    def rest(self) -> np.ndarray:
        """The rig with every leg at rest and no far legs: should equal the source
        everywhere except where the source's own far legs were."""
        acc = self.body.copy()
        for spec in NEAR_LEGS:
            leg = self.legs[spec.name]
            acc = _over(self._render_leg(leg, np.zeros(2), 0.0, 0.0, 0.0, 0.0), acc)
        return _unpremultiply(acc)

    def frames(self) -> list[np.ndarray]:
        return [self.frame(k) for k in range(FRAMES)]
