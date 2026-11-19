# 猫咪精灵图生成 Prompt

需要重新出图的动作只剩下面两个，其余动作都已经绑骨或者沿用现有素材。每个 prompt 都是完整的，附上对应的参考图后，整段粘贴进去即可。参考图都在 `rsrc/ref/`。

---

## 1. lie_down：躺下（8 帧，2×4，画布 1792×1024）

**功能**：猫从侧面坐着，慢慢趴下，最后蜷成一团睡觉。现在只有 4 个姿势，衔接时会跳，重画后会补齐中间的过渡。播放时倒过来就是起床（wake_up）。

**参考图**（按顺序附上）：
1. `ref_side_sit_faces_left_white.png`：侧面坐姿，用作第 1 帧
2. `ref_curled_asleep_faces_left_white.png`：蜷着睡觉，用作第 8 帧

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference images: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of 2 rows x 4 columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its body resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

Content: an 8-frame side-view LIE DOWN, the kitten facing LEFT the whole time, camera fixed. This is an in-between sheet: the first and last frames are given, draw the motion between them.
Frame 1: EXACTLY the pose of attached image 1 (sitting, seen from the side).
Frame 8: EXACTLY the pose of attached image 2 (curled up asleep in a ball, tail over the nose, eyes closed).
Frames 2-7 move evenly from frame 1 to frame 8, each a small step:
2. front paws start to walk forward, chest begins to lower, eyes open.
3. front legs stretched forward, chest low, haunches still up.
4. haunches sink, the cat is lying on its belly (sphinx pose), head up.
5. lying on its belly, head lowering, eyes half closed, tail starting to curve forward.
6. body rolls slightly onto its side and starts to curl, head tucking toward the chest.
7. almost fully curled, tail sweeping over the front paws, eyes closed.
The cat keeps the same size and the same fur colours in every frame; it never grows or shrinks. The body stays on the same ground line and does not slide left or right across the cell.
```

---

## 2. stretch：伸懒腰打哈欠（12 帧，3×4，画布 1792×1024）

**功能**：猫侧身站着，前腿往前伸，压低前身做出"伏地伸展"，在最低处打个大哈欠，再后腿往后伸一下，最后回到站姿。现在只有 5 个姿势，而且第 1、2 帧之间头的大小对不上，重画是为了让整个过程连贯，头的大小也保持一致。

**参考图**：
1. `ref_stretch_start_faces_left_white.png`：侧面站立，用作第 1 帧和第 12 帧

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of 3 rows x 4 columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

Content: a 12-frame side-view STRETCH and YAWN, the kitten facing LEFT, camera fixed. It starts and ends standing, in EXACTLY the pose of the attached image; draw only the motion in between.
1. EXACTLY the attached pose.
2. front paws start sliding forward, head stays level.
3. front legs reaching further forward, chest lowering.
4. play-bow: chest almost on the ground, front legs straight out in front, rear end and tail high.
5. same play-bow, mouth starting to open, eyes closing.
6. same play-bow, mouth WIDE open in a big yawn, eyes squeezed shut, ears slightly back.
7. same as 6, the yawn held.
8. mouth closing, eyes still shut.
9. front end rises, weight shifting forward over the front paws.
10. standing level, one hind leg stretched out straight behind.
11. hind leg coming back under the body.
12. EXACTLY the attached pose again, identical to frame 1.
The head is the SAME size in every frame. Frames 5-7 are the same body pose with only the face changing. The paws stay on the same ground line.
```

---

两张都已生成并接入：lie_down 是 `rsrc/raw/new_new.png`，stretch 是 `rsrc/raw/new_new2.png`（见 `tools/build_assets.py` 的 `SHEETS`）。以后要重画，用同样的 prompt 生成后覆盖这两个文件，再跑 `npm run assets`。
