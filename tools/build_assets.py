"""
Cut every raw cat sheet into per-action sprite folders for the app.

The raw art arrives in three different shapes and this tool normalises all of it:

  * `rsrc/raw/*.png`      already cut out, real alpha, 4x4 grid, faint grey gridlines
  * `rsrc/raw/enw/*.png`  magenta screen, 2x4 grid, white gridlines
  * `rsrc/raw/new2/*.png` magenta screen, 2x4 grid, clean

Three things have to be true for the cat to read as one animal rather than a
flipbook of different cats:

  1. The magenta has to come off without leaving a halo. A distance-to-magenta
     matte reads a half-covered black outline as "not magenta" and leaves a purple
     fringe, so the matte is a chroma metric instead -- see `key_magenta`.
  2. Every sheet draws the cat at its own size, so a per-sheet scale is derived from
     a reference pose (a sit or a stand) measured against one anchor sheet. Without
     this the cat visibly changes size the moment it stands up.
  3. Every frame is bottom-aligned on a shared ground line, so the cat never hops
     vertically when one animation hands over to the next.

Run:
    python tools/build_assets.py           # build assets/sprites
    python tools/build_assets.py --probe   # dump numbered contact sheets only
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

import pose_rig
import walk_rig

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "sprites"
CHECK = ROOT / "rsrc" / "_check"

# ---- keying -------------------------------------------------------------------------

KEY_COLOR = np.array([255.0, 0.0, 255.0], dtype=np.float32)
A_BG = 0.25
A_LO, A_HI = 0.22, 0.90
EDGE_BAND_PX = 6.0
A_SPECK = 0.90
SPECK_DEPTH_PX = 2.0
MAX_SPECK_AREA = 400

# ---- slicing ------------------------------------------------------------------------

# 0.55 is deliberately high. `default_and_head_tilt.png` carries faint grey gridlines
# at alpha 59-123 (0.23-0.48) which form a lattice touching several cats, so they
# cannot be rejected as "thin and long" blobs -- they come through as one sheet-sized
# component. The cat bodies are alpha 250-255, so thresholding above the gridlines
# separates them outright. Soft fur edges are recovered afterwards by dilating the
# blob before cropping.
SOLID_ALPHA = 0.55  # alpha above which a pixel can seed a frame blob
MIN_BLOB_AREA = 400  # ignore blobs smaller than this
# Gridlines and sheet borders show up as blobs that run across most of the sheet while
# staying only a few pixels thick. Cats never do that: the widest pose covers about a
# third of a sheet.
LINE_SPAN = 0.55
LINE_THICKNESS = 16
# Two of the enw sheets have white gridlines drawn over the magenta. White passes the
# chroma matte as solid foreground and the lattice touches several cats, so it cannot
# be rejected as a thin blob later -- it has to come off before the matte is built.
# Scoped to near-white blobs that run across the sheet: the sheets with gridlines have
# ~10k near-white pixels, the clean ones only 200-900 (genuine bright fur highlights),
# and those stay.
GRIDLINE_WHITE = 235

# ---- output -------------------------------------------------------------------------

CANVAS = 256
MARGIN = 6
BASELINE = CANVAS - 4


@dataclass
class Sheet:
    key: str
    path: str
    rows: int
    cols: int
    source: str  # 'magenta' or 'alpha'
    family: str  # sheets from one generator run share a scale
    note: str = ""
    # Correction on top of the family scale, for a sheet that disagrees with its own
    # family. Should stay 1.0 unless there is a measurement saying otherwise; see the
    # `side` sheet below for the one case that needs it.
    scale: float = 1.0


# Scale is resolved per *family*, not per sheet. Sheets from one generator run already
# draw the cat at a consistent size, so rescaling them against each other would do
# harm: a standing profile is genuinely shorter than a front stand with the tail up,
# and height-matching those two would shrink the profile by ~6% for no reason.
# Across families the drawing size really does differ, so one reference pose per
# family -- a plain front sit, the one pose every family has -- ties them together.
FAMILY_REF: dict[str, tuple[str, int]] = {
    "enw": ("stand", 3),  # anchor family; everything else matches this sit
    "new2": ("front", 0),
    "tilt": ("tilt", 0),
    "feed": ("feed", 0),  # both feeding sheets open on a plain front sit
}
ANCHOR_FAMILY = "enw"

SHEETS: list[Sheet] = [
    Sheet("tilt", "rsrc/raw/default_and_head_tilt.png", 4, 4, "alpha", "tilt",
          "front sit: blink frames 0-7, head tilt frames 8-15"),
    Sheet("stand", "rsrc/raw/enw/Designer (1).png", 2, 4, "magenta", "enw",
          "crouched sit rising to a full stand (f0 lowest -> f7 standing)"),
    # Redrawn to hold its proportions through the rotation. The sheet it replaces,
    # rsrc/raw/enw/Designer.png, drew the head-on frame 7% taller than the profiles
    # with a visibly larger head, which read as the cat growing mid-turn. This one
    # also matches the walk sheet's scale outright (x0.997) where the old one was 2%
    # under. Filed under the enw family because that is the scale it matches, despite
    # living in the new3 folder.
    Sheet("turn", "rsrc/raw/new3/Designer (1).png", 2, 4, "magenta", "enw",
          "continuous turn: f0 right profile -> f4 front -> f7 left profile"),
    # No walk sheet: the walk is rigged in code from turn f7, see tools/walk_rig.py.
    # The last generated one, rsrc/raw/enw/Designer (2).png, never alternated its
    # hind legs and only flipped its front paws between up and down.
    # The old sleep and stretch sheets (new2/Designer.png, new2/Designer (2).png) are
    # gone: lie_down, sleep and stretch now come from the in-between sheets below.
    Sheet("front", "rsrc/raw/new2/Designer (1).png", 2, 4, "magenta", "new2",
          "f0-f3 front sit blink, f4-f7 grooming"),
    Sheet("run", "rsrc/raw/new2/Designer (4).png", 2, 4, "magenta", "new2",
          "f0-f3 run cycle facing left, f4-f7 front sit waving"),
    # Purpose-drawn startle, side on and facing left, at the enw family's scale: its
    # two neutral standing frames measure 334 and 335 against the walk sheet's 333,
    # so it needs no correction at all. It replaces rsrc/raw/new2/Designer (3).png,
    # whose standing cat was 8% small and in the slimmer new2 drawing style, so a
    # startle handing over to the enw turn looked like a different, growing cat.
    Sheet("startle", "rsrc/raw/new3/Designer.png", 2, 4, "magenta", "enw",
          "8-frame startle: f0 neutral stand -> f4/f5 arched and hissing -> f7 stand"),
    # The feeding pair, drawn in one run and therefore one family. Both sheets open on
    # a plain front sit, which is what ties them to the rest of the cat: f0 is the
    # frame the family scale is measured on *and* the pose the animations hand back
    # to, so a mouth opening can start from the resting sit without a jump.
    Sheet("feed", "rsrc/raw/new-10.13/Designer.png", 2, 4, "magenta", "feed",
          "front sit being offered food: f0 neutral -> f3 mouth wide open -> f7 neutral"),
    Sheet("chew", "rsrc/raw/new-10.13/Designer (1).png", 2, 4, "magenta", "feed",
          "front sit eating: f1 a mouthful -> f5 swallow -> f6 licks its muzzle -> f7 content"),
    # The two in-between sheets drawn from rsrc/PROMPTS.md. Neither has a front sit
    # to measure a family scale on, so each is matched on the pose it shares with
    # the rest of the cat: the curl (f7) against the old sleep curl it replaces,
    # 250px x0.863 = 216 / 247; and the side stand (f0) against turn f7, 334 / 276.
    Sheet("liedown", "rsrc/raw/new_new.png", 2, 4, "magenta", "enw",
          "side sit -> sphinx -> curled asleep, facing left", scale=0.874),
    Sheet("stretch", "rsrc/raw/new_new2.png", 3, 4, "magenta", "enw",
          "side stand -> play-bow yawn -> hind-leg stretch -> stand, facing left",
          scale=1.21),
]


# =====================================================================================
# Keying
# =====================================================================================


def gridline_mask(rgb: np.ndarray) -> np.ndarray:
    """Near-white gridlines: near-white blobs whose bbox runs across the sheet."""
    h, w, _ = rgb.shape
    near_white = rgb.min(axis=2) >= GRIDLINE_WHITE
    found = np.zeros((h, w), dtype=bool)
    if not near_white.any():
        return found
    labels, n = ndimage.label(near_white)
    for i, box in enumerate(ndimage.find_objects(labels), start=1):
        ys, xs = box
        if (xs.stop - xs.start) > LINE_SPAN * w or (ys.stop - ys.start) > LINE_SPAN * h:
            found |= labels == i
    if found.any():
        # Take the antialiased shoulders of the line with it, or a faint ghost of the
        # line survives in the soft-edge band.
        found = ndimage.binary_dilation(found, iterations=2)
    return found


def key_magenta(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Pull a magenta screen off a sheet. Returns (rgb float32, alpha float32 0..1).

    The matte is a chroma metric rather than a distance to the key colour: against a
    magenta screen (R=255, G=0, B=255) the coverage of a non-magenta subject is

        alpha = 1 - (min(R, B) - G) / 255

    which is the algebraic inverse of compositing over the screen. It stays accurate
    on the cat's dark outline and on wispy fur, while the cat's own pinks (ears, nose,
    tongue) keep full opacity because none of them are magenta-saturated.
    """
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    spill = np.clip(np.minimum(r, b) - g, 0.0, 255.0)
    a_est = 1.0 - spill / 255.0

    # Plain global threshold, no border flood fill: nothing in the cat's palette gets
    # this saturated, so screen pockets fully enclosed by fur get keyed out too.
    bg = a_est < A_BG
    grid = gridline_mask(rgb)
    if grid.any():
        print(f"      removed {int(grid.sum())} px of white gridline")
        bg |= grid

    fg_labels, fg_n = ndimage.label(~bg)
    if fg_n:
        areas = ndimage.sum(np.ones_like(fg_labels), fg_labels, range(1, fg_n + 1))
        tiny = [i + 1 for i, area in enumerate(areas) if area < MIN_BLOB_AREA]
        if tiny:
            bg |= np.isin(fg_labels, tiny)

    alpha = np.where(bg, 0.0, 1.0).astype(np.float32)

    # Trust the coverage estimate only in a band hugging the matte, so interior pinks
    # keep full opacity whatever the chroma metric says about them.
    inward = ndimage.distance_transform_edt(~bg)
    band = (inward > 0) & (inward <= EDGE_BAND_PX)
    soft = np.clip((a_est - A_LO) / (A_HI - A_LO), 0.0, 1.0)
    alpha[band] = np.minimum(alpha[band], soft[band])

    # Un-premultiply the screen out of partially covered pixels, so a half-covered
    # whisker reads as cream rather than pink.
    out = rgb.copy()
    a = alpha[..., None]
    fix = band & (alpha > 0.02)
    unspilled = (rgb - (1.0 - a) * KEY_COLOR) / np.maximum(a, 1e-3)
    out[fix] = np.clip(unspilled[fix], 0.0, 255.0)

    # Residual despill for edge pixels the contrast stretch pushed back to opaque.
    resid = np.clip(np.minimum(out[..., 0], out[..., 2]) - out[..., 1] - 8.0, 0.0, 255.0)
    resid = np.where(band, resid, 0.0)
    out[..., 0] -= resid
    out[..., 2] -= resid
    out = np.clip(out, 0.0, 255.0)

    # Paint over screen pockets stranded deep inside the body (gaps between tail and
    # flank, between the toes). Keying them transparent would punch pinholes instead.
    speck = (a_est < A_SPECK) & (inward > SPECK_DEPTH_PX)
    if speck.any():
        labels, n = ndimage.label(speck)
        h, w = a_est.shape
        areas = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        for i, box in enumerate(ndimage.find_objects(labels), start=1):
            ys, xs = box
            on_border = ys.start == 0 or xs.start == 0 or ys.stop >= h or xs.stop >= w
            keep[i] = areas[i - 1] <= MAX_SPECK_AREA and not on_border
        speck = keep[labels]

    if speck.any():
        speck = ndimage.binary_dilation(speck, iterations=2) & ~bg
        # Source colour must be clean *and* part of the cat: "nearest non-speck pixel"
        # would happily grab a background pixel, which still holds pure key colour at
        # this point, and smear magenta into the body.
        valid = ~speck & ~bg
        _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
        out[speck] = out[iy[speck], ix[speck]]
        alpha[speck] = 1.0

    out[alpha <= 0.02] = 0.0
    return out, alpha


def load_alpha_sheet(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Use a sheet's existing alpha channel as-is."""
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32)
    return rgba[..., :3], rgba[..., 3] / 255.0


# =====================================================================================
# Slicing
# =====================================================================================


@dataclass
class Frame:
    rgba: np.ndarray  # HxWx4 uint8, tightly trimmed
    sheet: str
    index: int
    cell_cx: float = 0.0  # centre x within its grid cell, sheet px

    @property
    def width(self) -> int:
        return self.rgba.shape[1]

    @property
    def height(self) -> int:
        return self.rgba.shape[0]


def slice_sheet(sheet: Sheet) -> list[Frame]:
    """Key a sheet and split it into rows*cols tightly-trimmed frames.

    Frames are located by connected-component centroid rather than by cutting the
    sheet on a rigid grid, so a pose that overflows its cell is never sliced in half.
    """
    img = Image.open(ROOT / sheet.path)
    if sheet.source == "magenta":
        rgb, alpha = key_magenta(img)
    else:
        rgb, alpha = load_alpha_sheet(img)
    h, w = alpha.shape

    labels, n = ndimage.label(alpha > SOLID_ALPHA)
    if n == 0:
        raise RuntimeError(f"{sheet.path}: nothing survived the key")

    areas = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
    boxes = ndimage.find_objects(labels)
    centres = [
        ((c + 0.5) * w / sheet.cols, (r + 0.5) * h / sheet.rows)
        for r in range(sheet.rows)
        for c in range(sheet.cols)
    ]
    cell_mask = [np.zeros(alpha.shape, dtype=bool) for _ in centres]
    dropped = 0

    for i, (box, area) in enumerate(zip(boxes, areas), start=1):
        if area < MIN_BLOB_AREA:
            continue
        ys, xs = box
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        spans_wide = bw > LINE_SPAN * w and bh < LINE_THICKNESS
        spans_tall = bh > LINE_SPAN * h and bw < LINE_THICKNESS
        if spans_wide or spans_tall:
            dropped += 1  # gridline or sheet border, not a cat
            continue
        blob = labels == i
        cy, cx = ndimage.center_of_mass(blob)
        best = min(
            range(len(centres)),
            key=lambda k: (cx - centres[k][0]) ** 2 + (cy - centres[k][1]) ** 2,
        )
        cell_mask[best] |= blob

    frames: list[Frame] = []
    for i, mask in enumerate(cell_mask):
        if not mask.any():
            raise RuntimeError(f"{sheet.path}: frame {i} came out empty")
        ys, xs = np.nonzero(mask)
        y0, y1 = ys.min(), ys.max() + 1
        x0, x1 = xs.min(), xs.max() + 1

        # Keep the soft edges around the blob, but suppress any neighbouring frame
        # that happens to reach into this bounding box.
        sub_a = alpha[y0:y1, x0:x1].copy()
        keep = ndimage.binary_dilation(mask[y0:y1, x0:x1], iterations=3)
        sub_a[~keep] = 0.0
        sub_rgb = rgb[y0:y1, x0:x1]

        rgba = np.concatenate(
            [np.clip(sub_rgb, 0, 255), np.clip(sub_a[..., None] * 255.0, 0, 255)],
            axis=2,
        ).astype(np.uint8)

        aa = rgba[..., 3]
        ys, xs = np.nonzero(aa > 2)
        rgba = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        # Where the frame's centre sat inside its own grid cell, for actions that
        # keep the sheet's own horizontal layout (see Action.keep_x).
        cell_left = (i % sheet.cols) * w / sheet.cols
        cx = x0 + xs.min() + rgba.shape[1] / 2 - cell_left
        frames.append(Frame(rgba, sheet.key, i, cx))

    if dropped:
        print(f"      dropped {dropped} gridline/border blob(s)")
    return frames


# =====================================================================================
# Scale normalisation and placement
# =====================================================================================


def reference_height(frames: list[Frame], which: tuple[int, ...]) -> float:
    return float(np.median([frames[i].height for i in which]))


def place(frame: Frame, scale: float, mirror: bool, dx: float = 0.0) -> Image.Image:
    """Scale a trimmed frame and bottom/centre-align it on the shared canvas, shifted
    `dx` canvas px off centre."""
    src = Image.fromarray(frame.rgba, "RGBA")
    if mirror:
        src = src.transpose(Image.FLIP_LEFT_RIGHT)
        dx = -dx
    tw = max(1, round(src.width * scale))
    th = max(1, round(src.height * scale))
    src = src.resize((tw, th), Image.LANCZOS)

    x = round((CANVAS - tw) / 2 + dx)
    if x < 0 or x + tw > CANVAS:
        raise RuntimeError(f"{frame.sheet}[{frame.index}] would leave the canvas "
                           f"(x {x}..{x + tw}); reduce its keep_x shift")
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(src, (x, max(0, BASELINE - th)))
    return canvas


# =====================================================================================
# Probe mode
# =====================================================================================


def probe(sheets: dict[str, list[Frame]]) -> None:
    """Dump numbered contact sheets so frame contents can be confirmed by eye."""
    out = CHECK / "frames"
    out.mkdir(parents=True, exist_ok=True)
    cell = 240
    for sheet in SHEETS:
        frames = sheets[sheet.key]
        cols = sheet.cols
        rows = (len(frames) + cols - 1) // cols
        img = Image.new("RGB", (cell * cols, cell * rows), (210, 210, 220))
        draw = ImageDraw.Draw(img)
        for i, frame in enumerate(frames):
            src = Image.fromarray(frame.rgba, "RGBA")
            fit = min((cell - 26) / src.width, (cell - 26) / src.height)
            src = src.resize(
                (max(1, round(src.width * fit)), max(1, round(src.height * fit))),
                Image.LANCZOS,
            )
            cx = (i % cols) * cell
            cy = (i // cols) * cell
            for yy in range(0, cell, 10):
                for xx in range(0, cell, 10):
                    shade = 240 if ((xx // 10) + (yy // 10)) % 2 else 215
                    draw.rectangle(
                        [cx + xx, cy + yy, cx + xx + 9, cy + yy + 9],
                        fill=(shade, shade, 225),
                    )
            img.paste(src, (cx + (cell - src.width) // 2, cy + cell - 18 - src.height), src)
            draw.rectangle([cx, cy, cx + cell - 1, cy + cell - 1], outline=(90, 90, 110))
            draw.text((cx + 6, cy + 4), f"{i}  {frame.width}x{frame.height}",
                      fill=(20, 20, 30))
        path = out / f"{sheet.key}.png"
        img.save(path)
        print(f"  {sheet.key:<7} {len(frames):2d} frames -> {path.relative_to(ROOT)}"
              f"   ({sheet.note})")


# =====================================================================================
# Actions
# =====================================================================================


@dataclass
class Action:
    name: str
    picks: list[tuple[str, int]]
    fps: float = 8.0
    loop: bool = True
    mirror: bool = False
    tags: list[str] = field(default_factory=list)
    # Frames come from the named entry in RIGS instead of `picks`.
    rig: str | None = None
    # Seconds per frame, overriding `fps`, so key poses can hold and in-betweens fly.
    durations: list[float] | None = None
    # Keep each frame where the sheet drew it inside its cell, instead of re-centring
    # every frame on its own bounding box. For one-sheet sequences whose outline
    # changes a lot (front paws reaching out, a leg kicking back): re-centring would
    # slide the planted paws about. The named frame is the one placed dead centre,
    # normally the one shared with the neighbouring animation.
    keep_x: tuple[str, int] | None = None


def _rig_walk(sheets):
    src = sheets["turn"][7]
    return pose_rig.Rigged(src.width, src.height, walk_rig.PAD,
                           walk_rig.WalkRig(src.rgba).frames(), walk_rig.FPS,
                           extra={"groundSpeed": walk_rig.GROUND_SPEED})


# Each rig, the source frame it is anchored on, and how it is built. Placing a rig
# exactly where its source frame is placed is what makes it hand over seamlessly to
# the drawn animations that share that frame: turn f7 for the walk, the plain sit,
# the stand's top frame, the curled-up sleep.
RIGS = {
    "walk": (("turn", 7), _rig_walk),
    "sit": (("tilt", 0), lambda s: pose_rig.rig_sit(s["tilt"][0].rgba)),
    "stand": (("stand", 7), lambda s: pose_rig.rig_stand(s["stand"][7].rgba)),
    # The curl lie_down ends on, so falling asleep has no cut. Ear tip (170, 15),
    # base along row ~72; the head is the left 220px, the back the rest.
    "sleep": (("liedown", 7), lambda s: pose_rig.rig_sleep(
        s["liedown"][7].rgba, back=(150, 260), ear_x=(136, 206), ear_rows=(80, 42),
        ear_pivot=(172, 74))),
    "happy": (("front", 3), lambda s: pose_rig.rig_happy(s["front"][3].rgba)),
    "wave": (("run", 4), lambda s: pose_rig.rig_wave(
        s["run"][4].rgba, s["run"][5].rgba, s["run"][7].rgba)),
    "groom": (("front", 4), lambda s: pose_rig.rig_groom(
        s["front"][0].rgba, s["front"][4].rgba, s["front"][5].rgba, s["front"][6].rgba)),
    "chew": (("chew", 1), lambda s: pose_rig.rig_chew(
        [f.rgba for f in s["chew"]], [1, 2, 3, 2, 4, 2])),
}

ACTIONS: list[Action] = [
    # ---- default resting state ----------------------------------------------------
    # The crouched front sit, where the cat lives by default: breathing, with an ear
    # flick now and then (tools/pose_rig.py). f0 is the drawn sit untouched, which
    # blink and head_tilt start from.
    Action("sit", [], loop=True, rig="sit", tags=["idle", "front"]),
    Action("blink", [("tilt", 0), ("tilt", 1), ("tilt", 2), ("tilt", 3),
                     ("tilt", 2), ("tilt", 1), ("tilt", 0)],
           fps=12.0, loop=False, tags=["accent", "front"]),

    # ---- click reaction: head tilt -------------------------------------------------
    Action("head_tilt", [("tilt", 0), ("tilt", 9), ("tilt", 10), ("tilt", 12),
                         ("tilt", 12), ("tilt", 12), ("tilt", 10), ("tilt", 9),
                         ("tilt", 0)],
           fps=9.0, loop=False, tags=["reaction", "front"]),

    # ---- standing up and sitting back down ----------------------------------------
    # Both of these stop at stand f3, not f2. f3 is the frame the family scale was
    # calibrated on, and it measures exactly the same height as the resting sit from
    # the tilt sheet (179px). f2 is a deeper crouch than the cat ever rests in, so
    # ending there made it sink 5% below the sit and then pop back up the instant the
    # resting pose took over -- on every single sit-down and stand-up.
    # Eased: a beat on the starting pose, through the middle quickly, settling on
    # the end pose, instead of five evenly spaced pops.
    Action("stand_up", [("stand", 3), ("stand", 4), ("stand", 5), ("stand", 6),
                        ("stand", 7)],
           loop=False, durations=[0.14, 0.09, 0.08, 0.09, 0.16],
           tags=["transition", "front"]),
    Action("sit_down", [("stand", 7), ("stand", 6), ("stand", 5), ("stand", 4),
                        ("stand", 3)],
           loop=False, durations=[0.12, 0.09, 0.08, 0.10, 0.18],
           tags=["transition", "front"]),
    # Standing still: breathing, the tail swaying behind the head.
    Action("stand", [], loop=True, rig="stand", tags=["idle", "front"]),

    # ---- turning. The turn sheet is one continuous sweep, so a right turn is just
    # the first half played backwards from the front pose.
    #
    # None of them shows the turn sheet's own front pose (f4). The stand before and
    # the sit_down after are the stand sheet's front stand, a different drawing of
    # that same pose; showing both back to back was a swap with the cat standing
    # still. Leaving f4 out puts the swap on a step of the rotation instead, where
    # the picture is meant to change.
    Action("turn_left", [("turn", 5), ("turn", 6), ("turn", 7)],
           fps=8.0, loop=False, tags=["transition"]),
    Action("turn_right", [("turn", 3), ("turn", 2), ("turn", 1), ("turn", 0)],
           fps=8.0, loop=False, tags=["transition"]),
    Action("face_front_from_left", [("turn", 7), ("turn", 6), ("turn", 5)],
           fps=8.0, loop=False, tags=["transition"]),
    Action("face_front_from_right", [("turn", 0), ("turn", 1), ("turn", 2),
                                     ("turn", 3)],
           fps=8.0, loop=False, tags=["transition"]),
    # After a startle: a hop round to face front, landing on the front stand that
    # sit_down starts from. Built in add_motion.
    Action("hop_to_front", [], loop=False, tags=["transition"]),

    # ---- walking: rigged, not drawn (tools/walk_rig.py). Faces left; the right
    # cycle is the same frames mirrored. --------------------------------------------
    Action("walk_left", [], loop=True, rig="walk", tags=["move", "left"]),
    Action("walk_right", [], loop=True, mirror=True, rig="walk",
           tags=["move", "right"]),

    # ---- sleeping ------------------------------------------------------------------
    # Eight evenly spaced poses from the in-between sheet (rsrc/raw/new_new.png):
    # side sit, paws walking forward, sphinx, head down, curled. Laid out as drawn,
    # so the haunches stay put as the front end lowers; centred on the curl, which
    # is the frame the sleep loop starts from.
    Action("lie_down", [("liedown", i) for i in range(8)], loop=False,
           durations=[0.24, 0.14, 0.14, 0.15, 0.17, 0.19, 0.22, 0.30],
           keep_x=("liedown", 7), tags=["transition", "side"]),
    # The curl, breathing (tools/pose_rig.py).
    Action("sleep", [], loop=True, rig="sleep", tags=["idle", "side"]),
    Action("wake_up", [("liedown", i) for i in range(7, -1, -1)], loop=False,
           durations=[0.30, 0.18, 0.15, 0.13, 0.12, 0.12, 0.12, 0.22],
           keep_x=("liedown", 7), tags=["transition", "side"]),

    # ---- flavour -------------------------------------------------------------------
    # Paw up, three licks, paw down (tools/pose_rig.py).
    Action("groom", [], loop=False, rig="groom", tags=["action", "front"]),
    # From the in-between sheet (rsrc/raw/new_new2.png): front paws slide out into a
    # play-bow, a big yawn held at the bottom, back up, stand. Laid out as drawn so
    # the hind paws stay planted through the bow. The sheet's f9-f10 (a hind leg
    # kicked out behind and drawn back in) are left out on purpose.
    Action("stretch", [("stretch", i) for i in (0, 1, 2, 3, 4, 5, 6, 7, 8, 11)],
           loop=False,
           durations=[0.20, 0.13, 0.13, 0.15, 0.16, 0.25, 0.50, 0.20, 0.20, 0.24],
           keep_x=("stretch", 0), tags=["action", "side"]),
    # Two happy hops with the head rocking (tools/pose_rig.py).
    Action("happy", [], loop=False, rig="happy", tags=["reaction", "front"]),
    # Paw up, waved twice, paw down (tools/pose_rig.py).
    Action("wave", [], loop=False, rig="wave", tags=["action", "front"]),

    # ---- being fed -----------------------------------------------------------------
    #
    # Four clips out of two sheets. Both sheets' f0 is the plain front sit, so
    # feed_open can start from the resting pose and swallow can hand back to it
    # without a visible cut. feed_wait is the one that loops: it has to hold for as
    # long as the user keeps dragging a file around, so it alternates a wide-open
    # mouth with a narrower one and an occasional lick rather than freezing on a
    # single gaping frame.
    Action("feed_open", [("feed", 0), ("feed", 1), ("feed", 2), ("feed", 3)],
           fps=8.0, loop=False, tags=["transition", "front"]),
    Action("feed_wait", [("feed", 3), ("feed", 4), ("feed", 3), ("feed", 5)],
           fps=3.0, loop=True, tags=["idle", "front"]),
    # Nothing arrived, or the user cancelled: close up and go back to sitting.
    Action("feed_close", [("feed", 2), ("feed", 6), ("feed", 7)],
           fps=7.0, loop=False, tags=["transition", "front"]),
    # Jaw working on a mouthful, the head nodding with each chew (tools/pose_rig.py).
    Action("chew", [], loop=True, rig="chew", tags=["action", "front"]),
    # Head up to get it down, a lick of the muzzle, then back to neutral so `sit`
    # can take over.
    Action("swallow", [("chew", 5), ("chew", 6), ("chew", 7), ("chew", 7),
                       ("chew", 0)],
           fps=4.0, loop=False, tags=["reaction", "front"]),

    # ---- being picked up and dropped -----------------------------------------------
    # Held is a single frame kept up for as long as the drag lasts: the strongest tilt
    # on the sheet, which reads as the cat craning to look at whoever has hold of it.
    Action("held", [("tilt", 12)], fps=1.0, loop=True, tags=["held", "front"]),
    # Landing after a drop: tense, fur up and back arched, a hiss held for a beat,
    # then deflating back to a neutral stand. Starts and ends on the sheet's two
    # neutral standing frames, which are the handover points -- f7 leaves the cat side
    # on and standing, facing left, for face_front_from_left to pick up.
    Action("startle", [("startle", 0), ("startle", 1), ("startle", 2), ("startle", 3),
                       ("startle", 4), ("startle", 5), ("startle", 4), ("startle", 3),
                       ("startle", 6), ("startle", 7)],
           fps=11.0, loop=False, tags=["reaction", "side"]),
]


def load_actions() -> list[Action]:
    return ACTIONS


def place_rigged(padded: np.ndarray, src_w: int, src_h: int, pad: int, scale: float,
                 mirror: bool) -> Image.Image:
    """Place a rig frame exactly where `place` puts the frame it was rigged from.

    A rig frame is that source frame plus `pad` of margin all round, with legs, tail
    or paw reaching into the margin. `place` would re-centre every frame on its own
    bounding box, so the body would shuffle as they move; this applies the source
    frame's own scale and offset to every frame instead, so the body holds still and
    a planted paw stays put."""
    tw = max(1, round(src_w * scale))
    th = max(1, round(src_h * scale))
    sx, sy = tw / src_w, th / src_h
    # Floored so the source box never reaches outside the padded frame.
    po, qo = int(pad * sx), int(pad * sy)
    box = (pad - po / sx, pad - qo / sy, pad + src_w + po / sx, pad + src_h + qo / sy)
    src = Image.fromarray(padded, "RGBA").resize((tw + 2 * po, th + 2 * qo),
                                                 Image.LANCZOS, box=box)
    if mirror:
        src = src.transpose(Image.FLIP_LEFT_RIGHT)

    x0 = max(0, round((CANVAS - tw) / 2)) - po
    y0 = max(0, BASELINE - th) - qo
    big = Image.new("RGBA", (CANVAS + 2 * po, CANVAS + 2 * qo), (0, 0, 0, 0))
    big.alpha_composite(src, (x0 + po, y0 + qo))
    canvas = big.crop((po, qo, po + CANVAS, qo + CANVAS))
    lost = np.asarray(big)[..., 3].astype(int).sum() - np.asarray(canvas)[..., 3].astype(int).sum()
    if lost > 255 * 4:
        raise RuntimeError("a rig frame reaches past the sprite canvas; tone down "
                           "that rig's motion")
    return canvas


@dataclass
class Rendered:
    images: list[Image.Image]
    fps: float
    durations: list[float] | None
    # Rig extras already converted to canvas units (e.g. the walk's groundSpeed).
    extra: dict


def render_actions(sheets: dict[str, list[Frame]], rel: dict[str, float],
                   global_scale: float, actions: list[Action]) -> dict[str, Rendered]:
    """Every action's frames, placed on the shared canvas, with its timing."""
    built: dict[str, pose_rig.Rigged] = {}
    out: dict[str, Rendered] = {}
    for action in actions:
        if action.rig:
            (src_key, _), build = RIGS[action.rig]
            if action.rig not in built:
                built[action.rig] = build(sheets)
            rig = built[action.rig]
            scale = rel[src_key] * global_scale
            images = [place_rigged(f, rig.anchor_w, rig.anchor_h, rig.pad, scale,
                                   action.mirror) for f in rig.frames]
            # The size the source frame is actually drawn at, as `place` rounds it.
            drawn = round(rig.anchor_w * scale) / rig.anchor_w
            extra = {k: round(v * drawn, 3) for k, v in rig.extra.items()}
            out[action.name] = Rendered(images, rig.fps, rig.durations, extra)
        else:
            ref_cx = None
            if action.keep_x:
                ak, ai = action.keep_x
                ref_cx = sheets[ak][ai].cell_cx
            images = []
            for k, i in action.picks:
                f, s = sheets[k][i], rel[k] * global_scale
                dx = (f.cell_cx - ref_cx) * s if ref_cx is not None and k == action.keep_x[0] else 0.0
                images.append(place(f, s, action.mirror, dx))
            out[action.name] = Rendered(images, action.fps, action.durations, {})
        r = out[action.name]
        if r.durations is not None:
            if len(r.durations) != len(r.images):
                raise RuntimeError(f"{action.name}: {len(r.durations)} durations for "
                                   f"{len(r.images)} frames")
            r.fps = len(r.images) / sum(r.durations)
    return out


# =====================================================================================
# Body motion at the drawing swaps
# =====================================================================================
#
# Several moves hand over between sheets that drew the same pose differently (the
# startle's side stand, the turn sheet, the stand sheet, the front sit). A swap
# while the cat is still reads as the picture changing. Animators hide a cut
# inside motion instead, and the motion here is real body movement -- a crouch
# before a hop, an impact squash on landing, a plop as the haunches hit the floor
# -- with the swap falling at the fastest moment of it. Nothing is morphed: every
# frame is a drawn frame, only squashed, stretched or lifted as a whole about the
# point where its paws meet the ground.


def paws_x(img: Image.Image) -> float:
    """Alpha centre of the bottom 18% of the cat: where it stands."""
    a = np.asarray(img)[..., 3] > 40
    ys = np.nonzero(a.any(axis=1))[0]
    top, bot = int(ys.min()), int(ys.max())
    return float(np.nonzero(a[int(bot - 0.18 * (bot - top)):bot + 1])[1].mean())


def body(img: Image.Image, sy: float = 1.0, sx: float = 1.0, lift: float = 0.0,
         dx: float = 0.0) -> Image.Image:
    """The frame scaled by (sx, sy) about its paws on the ground line, then raised
    `lift` px and moved `dx` px sideways. sy < 1 with sx > 1 is a squash, the
    reverse a stretch; volume roughly kept, as a body does."""
    px = paws_x(img)
    # Output (x, y) shows source (a*x + c, e*y + f).
    a, e = 1.0 / sx, 1.0 / sy
    c = px - (px + dx) * a
    f = BASELINE - (BASELINE - lift) * e
    out = img.transform(img.size, Image.AFFINE, (a, 0, c, 0, e, f), Image.BICUBIC)
    if np.asarray(out)[..., 3].astype(int).sum() < np.asarray(img)[..., 3].astype(int).sum() * 0.97 * sx * sy:
        raise RuntimeError("a squash/hop frame was clipped by the sprite canvas")
    return out


def add_motion(rendered: dict[str, "Rendered"], sheets: dict[str, list[Frame]],
               rel: dict[str, float], global_scale: float) -> None:
    def frame(key, idx):
        return place(sheets[key][idx], rel[key] * global_scale, False)

    def timing(r):
        return list(r.durations) if r.durations else [1.0 / r.fps] * len(r.images)

    # ---- landing: the impact squashes the cat before it bristles ---------------
    r = rendered["startle"]
    first, before = r.images[0], timing(r)
    r.images = [body(first, 0.86, 1.08), body(first, 0.95, 1.03)] + r.images
    r.durations = [0.05, 0.05] + before

    # ---- after the startle: a hop round to face front --------------------------
    # Crouch, spring, turn in the air through the turn sheet's three-quarter views,
    # come down on the stand sheet's front stand -- the frame sit_down starts from
    # -- and absorb the landing. The cat travels from where its side-on paws were
    # to where the front stand's are, as a hop would.
    side = rendered["startle"].images[-1]
    t6, t5, front = frame("turn", 6), frame("turn", 5), rendered["sit_down"].images[0]
    x0 = 0.0
    x1 = paws_x(front) - paws_x(side)

    def at(img, t):
        """Shift `img` so its paws sit fraction t of the way from start to end."""
        return x0 + (x1 - x0) * t - (paws_x(img) - paws_x(side))

    hop = [
        (side, 0.94, 1.03, 0, 0.0, 0.07),
        (side, 0.88, 1.06, 0, 0.0, 0.08),   # crouch
        (side, 1.06, 0.97, 7, 0.15, 0.04),  # spring
        (t6, 1.04, 0.98, 15, 0.4, 0.05),
        (t5, 1.00, 1.00, 18, 0.65, 0.05),   # top of the hop, mid-turn
        (front, 1.03, 0.98, 10, 0.9, 0.05),
        (front, 0.90, 1.05, 0, 1.0, 0.06),  # land
        (front, 1.03, 0.99, 0, 1.0, 0.06),
        (front, 1.00, 1.00, 0, 1.0, 0.10),
    ]
    r = rendered["hop_to_front"]
    r.images = [body(img, sy, sx, lift, at(img, t) if img is not side else 0.0)
                for img, sy, sx, lift, t, _ in hop]
    r.durations = [d for *_, d in hop]

    # ---- standing up: a crouch first, a push up through the swap ---------------
    r = rendered["stand_up"]
    sit = rendered["sit"].images[0]
    r.images = [body(sit, 0.95, 1.025), body(r.images[0], 1.03, 0.985)] + r.images[1:]
    r.durations = [0.08, 0.06] + timing(r)[1:]

    # ---- sitting down: the haunches plop onto the floor, then the sit -----------
    r = rendered["sit_down"]
    last = r.images[-1]
    r.images = r.images + [body(last, 0.94, 1.03)]
    r.durations = timing(r) + [0.06]

    for r in rendered.values():
        if r.durations:
            r.fps = len(r.images) / sum(r.durations)


def main() -> None:
    probe_only = "--probe" in sys.argv

    print(f"slicing {len(SHEETS)} sheets")
    sheets: dict[str, list[Frame]] = {}
    for sheet in SHEETS:
        print(f"  {sheet.key:<7} {sheet.path}")
        sheets[sheet.key] = slice_sheet(sheet)

    if probe_only:
        print("\nprobe mode: contact sheets only")
        probe(sheets)
        return

    # ---- per-family scale, so a sit is a sit no matter which sheet drew it ---------
    ref_sheet, ref_frame = FAMILY_REF[ANCHOR_FAMILY]
    target_sit = sheets[ref_sheet][ref_frame].height
    print(f"\nanchor family '{ANCHOR_FAMILY}': front sit measures {target_sit}px tall")

    family_scale: dict[str, float] = {}
    for family, (fsheet, fframe) in FAMILY_REF.items():
        own = sheets[fsheet][fframe].height
        family_scale[family] = target_sit / own
        print(f"  family {family:<5} sit ref {fsheet}[{fframe}] {own:4d}px "
              f"-> x{family_scale[family]:.3f}")

    rel = {sheet.key: family_scale[sheet.family] * sheet.scale for sheet in SHEETS}
    for sheet in SHEETS:
        if sheet.scale != 1.0:
            print(f"  sheet {sheet.key:<6} corrected within its family -> x{sheet.scale:.3f}")

    # ---- one global scale on top, so nothing clips the canvas ---------------------
    worst_w = max(f.width * rel[k] for k, fs in sheets.items() for f in fs)
    # A keep_x action places frames off centre, so it needs room either side of the
    # centre line for its furthest-reaching frame, not just for its widest one.
    for action in load_actions():
        if not action.keep_x:
            continue
        ak, ai = action.keep_x
        ref_cx = sheets[ak][ai].cell_cx
        for k, i in action.picks:
            f = sheets[k][i]
            off = f.cell_cx - ref_cx if k == ak else 0.0
            reach = abs(off) + f.width / 2
            worst_w = max(worst_w, 2 * reach * rel[k])
    worst_h = max(f.height * rel[k] for k, fs in sheets.items() for f in fs)
    global_scale = min((CANVAS - 2 * MARGIN) / worst_w, (BASELINE - MARGIN) / worst_h)
    print(f"\nglobal scale {global_scale:.4f} "
          f"(largest normalised pose {worst_w:.0f}x{worst_h:.0f})")

    actions = load_actions()
    # Render first: a failure here must not leave assets/sprites deleted.
    rendered = render_actions(sheets, rel, global_scale, actions)
    add_motion(rendered, sheets, rel, global_scale)
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    manifest = {
        "canvas": CANVAS,
        "baseline": BASELINE,
        "actions": {},
    }

    drawn_height: dict[str, list[int]] = {}
    # A frame that is pixel-for-pixel the same as one already written is not written
    # again: the manifest points at the first copy. A third of all frames are repeats
    # -- sit_down is stand_up backwards, wake_up is lie_down backwards, loops repeat
    # their key poses -- and they were a third of the installer's art.
    written: dict[bytes, str] = {}

    for action in actions:
        files = []
        heights = []
        r = rendered[action.name]
        for i, img in enumerate(r.images):
            key = hashlib.sha1(img.tobytes()).digest()
            rel_path = written.get(key)
            if rel_path is None:
                rel_path = f"{action.name}/{i:03d}.png"
                (OUT / action.name).mkdir(parents=True, exist_ok=True)
                img.save(OUT / rel_path)
                written[key] = rel_path
            files.append(rel_path)
            rows = np.nonzero(np.asarray(img)[..., 3] > 24)[0]
            heights.append(int(rows.max() - rows.min() + 1) if len(rows) else 0)
        drawn_height[action.name] = heights
        spec = {
            "frames": files,
            "fps": round(r.fps, 4),
            "loop": action.loop,
            "tags": action.tags,
        }
        if r.durations is not None:
            # Seconds per frame; the app prefers this over fps when present.
            spec["durations"] = [round(d, 4) for d in r.durations]
        # The walk's groundSpeed: canvas px/s a planted paw slides back. The app must
        # move the cat at exactly this (times its render scale) or the feet skate.
        spec.update(r.extra)
        manifest["actions"][action.name] = spec
        flags = "".join(
            [" loop" if action.loop else "", " mirrored" if action.mirror else "",
             f" rig:{action.rig}" if action.rig else "",
             " timed" if r.durations else ""]
        )
        print(f"  {action.name:<16} {len(files):2d} frames @ {r.fps:5.1f}fps"
              f"  h{min(heights)}-{max(heights)}{flags}")

    # How tall the resting sit is actually drawn, so the app can size its render box
    # to put the cat at a chosen number of screen pixels. Without this the renderer
    # has to hardcode a box size that silently goes wrong whenever the global scale
    # moves -- which it does whenever a sheet is added or redrawn. Taken from the
    # drawn sit (the breathing loop's f0) so a deeper breath cannot resize the cat.
    manifest["sitHeight"] = drawn_height["sit"][0]

    report_scale_continuity(drawn_height)

    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    total = sum(len(a["frames"]) for a in manifest["actions"].values())
    print(f"\nwrote {total} frames across {len(actions)} actions "
          f"({len(written)} unique images) -> {OUT.relative_to(ROOT)}")

    build_qa(rendered, actions)


# The exact frames that hand over from one animation to the next, where a scale
# disagreement between sheets is visible as the cat changing size. Each entry is
# (action, frame index, what the pose is). Checked by frame rather than by taking an
# action's shortest frame: a startle's shortest frame is the tense one with its tail
# down, which is not the frame it hands over on.
HANDOVER_FRAMES = [
    ("stand", 0, "front stand (stand sheet)"),
    ("turn_left", 0, "three-quarter stand (turn sheet)"),
    ("face_front_from_left", 0, "left profile stand"),
    ("walk_left", 0, "walking side-on"),
    # Frame 2: frames 0-1 are the landing squash added in add_motion.
    ("startle", 2, "startle entry stand"),
    ("startle", -1, "startle exit stand"),
]


def report_scale_continuity(drawn_height: dict[str, list[int]]) -> None:
    """Flag scale drift between sheets, the way the old startle sheet drifted.

    Checks the two things that gave that bug away: a standing cat must not be shorter
    than a sitting one, and the poses that hand over to each other must agree.
    """
    print("\nscale continuity, at the frames that hand over:")
    sit_h = max(drawn_height.get("sit", [0]))

    measured = []
    for name, idx, label in HANDOVER_FRAMES:
        heights = drawn_height.get(name)
        if not heights:
            continue
        measured.append((f"{name}[{idx}]", heights[idx], label))

    if not measured:
        return

    for key, h, label in sorted(measured, key=lambda m: m[1]):
        print(f"  {key:<26} {h:3d}px  {label}")
    print(f"  {'sit[0]':<26} {sit_h:3d}px  sitting (the resting pose)")

    lo = min(measured, key=lambda m: m[1])
    hi = max(measured, key=lambda m: m[1])
    spread = hi[1] / max(1, lo[1]) - 1

    problems = []
    if lo[1] <= sit_h:
        problems.append(
            f"{lo[0]} stands {lo[1]}px tall but a sitting cat is {sit_h}px -- a "
            f"standing cat cannot be shorter than a sitting one, so that sheet's "
            f"scale is wrong"
        )
    if spread > 0.08:
        problems.append(
            f"handover poses disagree by {spread * 100:.0f}% "
            f"({lo[0]} {lo[1]}px vs {hi[0]} {hi[1]}px); the cat will look like it "
            f"changes size between them"
        )

    if problems:
        print("\n  WARNING: sheet scales look inconsistent")
        for p in problems:
            print(f"    - {p}")
        print("    fix with a `scale=` correction on the offending Sheet")
    else:
        print(f"  ok: handover poses agree within {spread * 100:.0f}%, "
              f"all taller than a sit")


def build_qa(rendered: dict[str, Rendered], actions: list[Action]) -> None:
    out = CHECK / "actions"
    out.mkdir(parents=True, exist_ok=True)

    checker = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 255))
    px = checker.load()
    for y in range(CANVAS):
        for x in range(CANVAS):
            if ((x // 8) + (y // 8)) % 2:
                px[x, y] = (205, 205, 215, 255)

    for action in actions:
        r = rendered[action.name]
        tiles = []
        for img in r.images:
            tile = checker.copy()
            tile.alpha_composite(img)
            tiles.append(tile)

        strip = Image.new("RGB", (CANVAS * len(tiles), CANVAS))
        for i, tile in enumerate(tiles):
            strip.paste(tile.convert("RGB"), (i * CANVAS, 0))
        strip.save(out / f"{action.name}_strip.png")

        if len(tiles) > 1:
            gif = [t.convert("P", palette=Image.ADAPTIVE) for t in tiles]
            ms = ([round(1000 * d) for d in r.durations] if r.durations
                  else round(1000 / r.fps))
            gif[0].save(
                out / f"{action.name}.gif",
                save_all=True,
                append_images=gif[1:],
                duration=ms,
                loop=0,
                disposal=2,
            )
    # The handover frames, side by side. If the cat changes size or hops vertically
    # between actions, it shows up here and nowhere else.
    handover = [
        ("sit", 0), ("blink", 3), ("head_tilt", 3),
        ("stand_up", 0), ("stand_up", -1), ("stand", 0),
        ("turn_left", -1), ("walk_left", 0), ("walk_left", 4),
        ("turn_right", -1), ("walk_right", 0),
        ("lie_down", -1), ("sleep", 0), ("stretch", 1),
    ]
    strip = Image.new("RGB", (CANVAS * len(handover), CANVAS + 16), (250, 250, 252))
    draw = ImageDraw.Draw(strip)
    for i, (name, idx) in enumerate(handover):
        tile = checker.copy()
        tile.alpha_composite(rendered[name].images[idx])
        strip.paste(tile.convert("RGB"), (i * CANVAS, 0))
        # Mark the shared ground line so drift is obvious.
        draw.line([(i * CANVAS, BASELINE), (i * CANVAS + CANVAS, BASELINE)],
                  fill=(220, 40, 40), width=1)
        draw.text((i * CANVAS + 4, CANVAS + 3), f"{name}[{idx}]", fill=(20, 20, 30))
    strip.save(CHECK / "continuity.png")

    print(f"QA strips and gifs -> {out.relative_to(ROOT)}")
    print(f"continuity check   -> {(CHECK / 'continuity.png').relative_to(ROOT)}")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
