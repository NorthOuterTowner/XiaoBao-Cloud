# 猫咪精灵图生成 Prompt 集

用于重新生成 / 补帧 `tools/build_assets.py` 用的原始精灵表。prompt 正文用英文，图像模型对英文更稳定。

用法：附上本节指定的参考图 → 粘贴「通用风格块」（替换 `{ROWS}`/`{COLS}`）→ 接上对应动作的 prompt。

---

## 参考图一览

参考图都在 `rsrc/ref/`。一律使用 `_white` 白底版本，避免模型把参考图背景画进新图。

| 文件 | 内容 | 用途 |
|---|---|---|
| `ref_side_stand_faces_left_white.png` | 侧面站立，朝左 | 所有侧面动作的主参考 |
| `ref_side_stand_faces_right_white.png` | 侧面站立，朝右 | 只用于转身 |
| `ref_front_stand_white.png` | 正面站立 | 转身、起身 |
| `ref_sit_front_white.png` | 正面坐姿 | 所有正面坐姿动作 |
| `ref_character_sheet_white.png` | 四个姿势的设定图 | 只用来锁定配色和花纹，可选 |

刻意不用的：

- `ref_side_midstride_faces_right_white.png`：迈步姿势会被模型照抄，而且朝向和要生成的朝左相反，会干扰步态。
- `template_2x4_groundline.png`：上面的灰色格线和蓝色地面线容易被画进图里。蓝线不在管线的格线清除范围内（只清近白色线），会残留在帧里。

附 `ref_character_sheet_white.png` 时，在 prompt 末尾加一句：

```
The attached character sheet is ONLY a colour and markings reference. Do not copy any of its poses.
```

### 每个动作附哪些图

| # | 动作 | 网格 | 画布 | 姿势参考（必附） | 可选 |
|---|---|---|---|---|---|
| 1 | walk 走路 | 3×4 | 1792×1024 | 侧面朝左 | 设定图 |
| 2 | run 跑步 | 2×4 | 1792×1024 | 侧面朝左 | 设定图 |
| 3 | turn 转身 | 3×3 | 1024×1024 | 侧面朝右 + 正面站立 + 侧面朝左 | — |
| 4 | stand_up / sit_down 起身 | 2×4 | 1792×1024 | 正面坐姿 + 正面站立 | — |
| 5 | sit_idle 坐姿呼吸 | 2×4 | 1792×1024 | 正面坐姿 | 设定图 |
| 6 | groom 理毛 | 3×4 | 1792×1024 | 正面坐姿 | 设定图 |
| 7 | stretch 伸懒腰 | 3×4 | 1792×1024 | 侧面朝左 | 设定图 |
| 8a | lie_down 躺下 | 2×4 | 1792×1024 | 侧面朝左 + 正面坐姿 | — |
| 8b | sleep 睡觉 | 2×4 | 1792×1024 | 侧面朝左 | 设定图 |
| 9 | happy / wave | 2×4 | 1792×1024 | 正面坐姿 | 设定图 |
| 10 | feed_open / chew 吃鱼 | 2×4 | 1792×1024 | 正面坐姿 | — |

多张参考图时，在 prompt 末尾说明每张的作用，例如转身：

```
Attached references: image 1 is the exact right-profile pose for frame 1, image 2 is the exact front pose for frame 5, image 3 is the exact left-profile pose for frame 9.
```

侧面动作只生成朝左的版本，朝右由管线镜像（`Action(..., mirror=True)`）。

---

## 通用风格块（每个 prompt 前都加上）

角色描述按 `rsrc/ref/` 里的参考图写：灰褐色长毛虎斑，深色近黑的大眼睛。

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.
```

---

## 1. walk：12 帧行走循环（3×4）

> **已弃用，不用再生成。** 走路现在由 `tools/walk_rig.py` 用代码绑骨生成：取 turn 表 f7（朝左侧面站立），切出腿，按四拍步态（左后→左前→右后→右前）做 16 帧，每条腿都有抬起、前摆、落地和支撑过程。图像模型试了多次都画不出交替的后腿。要调步幅、抬脚高度、速度，改 `walk_rig.py` 顶部的常量后重跑 `npm run assets`。下面的 prompt 只留作记录。

参考图：`ref_side_stand_faces_left_white.png`

现在的走路出问题，是因为相位错了。猫慢走是四拍步态（左后 → 左前 → 右后 → 右前），两条后腿始终相差半个周期，所以要逐帧写清每条腿的位置。另外规定第 7–12 帧就是第 1–6 帧近、远侧腿互换，这条规则模型更容易照做。

```
{STYLE with ROWS=3, COLS=4}

Content: a 12-frame looping side-view WALK cycle. The kitten faces LEFT (head on the left), seen exactly from the side, walking at a calm pace, tail held up in a relaxed curve that sways slightly. Use the attached side-view image as the exact body shape, proportions and size.
Legs: "near" legs are the ones closest to the viewer (drawn fully, slightly lighter); "far" legs are partly hidden behind the body (drawn a little darker). The two hind legs must ALWAYS be in opposite positions - when one hind leg is forward the other is back - they are never side by side and never on the same side of the hip. Same for the two front legs.
Frame by frame (NH = near hind, FH = far hind, NF = near front, FF = far front):
1. NH planted far forward under the belly; FH stretched far back pushing off on its toes; NF lifted, swinging forward; FF straight down under the shoulder.
2. NH planted forward; FH just lifted behind, bent; NF reaching forward in the air; FF planted slightly back.
3. NH planted slightly forward; FH raised and passing under the body; NF coming down in front; FF planted back.
4. NH straight down under the hip; FH swinging forward in the air; NF touching down far forward; FF stretched back pushing off.
5. NH planted slightly back; FH reaching forward in the air; NF planted forward; FF just lifted behind.
6. NH planted back; FH coming down in front; NF planted slightly forward; FF raised and passing under the body.
7-12. Repeat frames 1-6 exactly, but with near and far legs swapped (frame 7 = frame 1 with NH<->FH and NF<->FF swapped, and so on).
The body stays level with only a tiny up-and-down bob; the head stays steady. Frame 12 must flow smoothly back into frame 1.
```

12 帧总是出错时，退回 2×4 的 8 帧：第 1–4 帧按上面第 1、3、4、6 帧的腿位，第 5–8 帧是第 1–4 帧近远腿互换。腿画对比帧数多更要紧。

---

## 2. run：8 帧奔跑（2×4）

参考图：`ref_side_stand_faces_left_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame looping side-view RUN (rotary gallop) cycle. The kitten faces LEFT, seen exactly from the side, ears slightly back, tail streaming out behind. Use the attached side-view image as the exact body shape, proportions and size.
The two hind legs are always slightly offset from each other (the far hind leg half a step behind the near one); they are never drawn overlapping in the same spot. Same for the front legs.
1. Gathered: all four legs bunched under the body, back arched upward, hind paws landing just behind the front paws.
2. Hind legs push off the ground one after the other; front legs start reaching forward; back starts to flatten.
3. Full extension in the air: front legs stretched far forward, hind legs stretched far back, body long and flat, no paws touching the ground.
4. Near front paw touches the ground far forward; far front paw just behind it in the air.
5. Far front paw lands; near front paw pushes back; hind legs swinging forward under the belly.
6. Front paws push off; hind legs come forward under the body; back begins to arch.
7. Body compressed in a short airborne moment, hind legs tucked forward past the front legs.
8. Hind paws land one after the other, legs gathering - flows back into frame 1.
Body rises and falls clearly with the gallop; the head stays fairly level.
```

---

## 3. turn：9 帧转身（3×3）

参考图（按顺序附）：`ref_side_stand_faces_right_white.png`、`ref_front_stand_white.png`、`ref_side_stand_faces_left_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=3, COLS=3}

Content: a 9-frame continuous TURN of a standing kitten, all four paws on the ground, the camera fixed.
Frame 1: exact right-side profile (head pointing RIGHT). Frames 2-4: rotating toward the viewer through three-quarter views. Frame 5: facing the viewer straight on, standing. Frames 6-8: continuing to rotate through three-quarter views. Frame 9: exact left-side profile (head pointing LEFT).
The rotation angle increases by the same amount every frame (about 22 degrees). The head, body and tail keep identical proportions throughout; the cat does not grow or shrink as it faces the viewer.
Attached references: image 1 is the exact pose for frame 1, image 2 is the exact pose for frame 5, image 3 is the exact pose for frame 9.
```

---

## 4. stand_up / sit_down：8 帧起身（2×4）

参考图（按顺序附）：`ref_sit_front_white.png`、`ref_front_stand_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame front-view STAND UP, the kitten facing the viewer.
Frame 1: resting front sit - haunches on the ground, front paws together, tail curled around the right side. Frames 2-7: the hind end rises smoothly, front legs straighten, the tail lifts. Frame 8: standing on all four legs, facing the viewer, tail up.
Each frame is evenly spaced in the motion. Frame 1 must be a normal relaxed sit, not a deeper crouch. (Played in reverse this is the sit-down.)
Attached references: image 1 is the exact pose for frame 1, image 2 is the exact pose for frame 8.
```

---

## 5. sit_idle：8 帧坐姿呼吸（2×4，替换只有 1 帧的静止 sit）

参考图：`ref_sit_front_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame looping IDLE of the kitten sitting facing the viewer, in exactly the pose of the attached reference in every frame: front paws together, tail curled around the right side.
Only subtle motion: the chest rises and falls once over the 8 frames (breathing); the tip of the tail flicks up gently in frames 3-6; in frame 5 one ear twitches slightly. Eyes open in every frame. The head stays in exactly the same position in every frame.
```

---

## 6. groom：12 帧理毛（3×4）

参考图：`ref_sit_front_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=3, COLS=4}

Content: a 12-frame front-view GROOMING sequence, the kitten sitting facing the viewer, starting from exactly the pose of the attached reference.
1: neutral sit. 2-3: raises its right front paw to its mouth. 4-6: licks the paw, small pink tongue visible, eyes half closed. 7-9: wipes the paw over its cheek and ear in a circular motion, head tilted. 10-11: lowers the paw. 12: neutral sit, identical to frame 1.
```

---

## 7. stretch：12 帧伸懒腰打哈欠（3×4）

参考图：`ref_side_stand_faces_left_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=3, COLS=4}

Content: a 12-frame side-view STRETCH and YAWN, the kitten facing LEFT. Use the attached side-view image as the exact body shape, proportions and size.
1: standing neutral, exactly the attached pose. 2-4: front legs slide forward, chest lowers to the ground, rear end stays high (play-bow stretch). 5-7: mouth opens into a wide yawn at the bottom of the stretch, eyes squeezed shut. 8-9: mouth closes, front end rises. 10-11: weight shifts forward, hind legs stretch out behind one at a time. 12: standing neutral, identical to frame 1.
```

---

## 8. lie_down 与 sleep（2×4 各一张）

### 8a. lie_down

参考图（按顺序附）：`ref_side_stand_faces_left_white.png`、`ref_sit_front_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame side-view LIE DOWN, the kitten facing LEFT. 1: sitting, seen from the side. 2-4: front legs slide forward and the body lowers. 5-6: lies on its belly, then rolls slightly onto its side. 7-8: curls up into a ball, tail wrapped over the nose, eyes closed.
Attached references: image 1 gives the side-view body shape and size; image 2 shows how the sitting pose looks (draw it from the side for frame 1).
```

### 8b. sleep

参考图：`ref_side_stand_faces_left_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame looping SLEEP, the kitten curled up in a ball facing LEFT, tail over its nose, eyes closed, same position in every frame. Match the fur, colours and size of the attached reference.
Only the breathing moves: the body slowly swells (frames 1-4) and sinks back (frames 5-8). In frame 6 one ear twitches. Nothing else moves.
```

---

## 9. happy / wave（2×4 各一张）

参考图：`ref_sit_front_white.png`

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame front-view HAPPY reaction, sitting facing the viewer, starting from exactly the pose of the attached reference. 1: neutral. 2-3: eyes close into happy arcs and the head lifts. 4-5: small bounce up on the front paws, mouth open in a smile. 6-7: settles back down, eyes still happy. 8: neutral, identical to frame 1.
```

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame front-view WAVE, sitting facing the viewer, starting from exactly the pose of the attached reference. 1: neutral. 2-3: raises its right front paw to head height. 4-7: waves the paw side to side twice, head tilted and smiling. 8: paw back down, identical to frame 1.
```

---

## 10. 吃鱼配套：feed_open / chew（2×4 各一张）

参考图：`ref_sit_front_white.png`。只附这一张，不加设定图，让头部位置尽量和现有 `sit` 一致。

所有帧里头部位置都要完全不动，这样每帧的嘴部坐标才稳定，鱼才能贴在嘴上。鱼由代码叠加上去，所以图里不要画食物。

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame front-view FEED OPEN, sitting facing the viewer in exactly the pose of the attached reference, looking slightly upward and to the RIGHT as if at food.
1: neutral sit, identical to the reference. 2-3: eyes widen, mouth begins to open. 4-6: mouth wide open, small pink tongue. 7: mouth narrower. 8: mouth wide open again.
The head, ears and body stay in EXACTLY the same position in every frame - only the mouth and eyes change. No food or objects anywhere in the image.
```

```
A sprite sheet for a 2D desktop pet game. The character is ONE chibi kitten, identical in every cell and identical to the attached reference image: very fluffy long fur in a warm grey-taupe colour with dark charcoal-brown tabby stripes, round head, large glossy dark brown (almost black) eyes with white highlights, small pink nose, pink inner ears with fur tufts, white whiskers, slightly lighter fawn muzzle and chest, short stubby legs with round paws in the same taupe colour, a big fluffy plume tail with dark rings. Soft painterly shading with a thin dark outline.
Layout rules (very important):
- Solid flat pure magenta background (#FF00FF) everywhere. No gradient, no floor, no ground shadow, no grid lines, no borders, no numbers, no text.
- The cells are evenly spaced in a strict grid of {ROWS} rows x {COLS} columns; read frames left-to-right, top-to-bottom.
- Exactly one cat per cell, centred in its cell, never touching or overlapping a neighbouring cell. Leave clear magenta space around every cat.
- The cat is drawn at exactly the same size and the same scale in every cell, with its paws resting on the same invisible ground line near the bottom of each cell.
- Same camera, same lighting, same colours in every cell. Only the pose changes, and it changes a small, even amount from one frame to the next, like consecutive frames of an animation.

{STYLE with ROWS=2, COLS=4}

Content: an 8-frame front-view CHEWING, sitting facing the viewer in exactly the pose of the attached reference, head turned very slightly to the RIGHT.
1: mouth slightly open as if biting something held sideways in its mouth. 2: jaw closed, cheeks full. 3: jaw open. 4: jaw closed, eyes half closed in pleasure. 5: jaw open. 6: jaw closed. 7: head tilts up to swallow. 8: licks its muzzle, tongue out, eyes closed.
The head stays in EXACTLY the same position in frames 1-6; only the jaw moves. No food or objects anywhere in the image.
```

---

## 接入管线

- **存放位置**：生成的图放到 `rsrc/raw/<新目录>/`，在 `tools/build_assets.py` 的 `SHEETS` 里加一个 `Sheet(key, path, rows, cols, "magenta", family, note)`。网格行列数直接按上表填。
- **缩放基准**：每次生成都是一个新的家族，需要一帧能和现有姿势对上高度。上面的 prompt 都安排好了：
  - 正面坐姿表：第 1 帧是普通正面坐，可直接写进 `FAMILY_REF`。
  - 侧面表（walk、run、stretch）：第 1 帧是侧面站立。没有正面坐姿，所以要像 startle 那样，把它的站立高度和现有 walk 表对比，再用 `Sheet.scale` 修正。
  - 生成时注意第 1 帧不要被画成动作的中间状态。
- **检查**：每张图先跑 `python tools/build_assets.py --probe`，在 `rsrc/_check/frames/` 里逐帧看腿位，没问题再改 `ACTIONS`。
- **插帧**：呼吸、尾巴这类小幅动作可以用离线插帧（RIFE / FILM）把帧数翻倍，不必重新生成。腿部这种大幅动作插帧会糊，还是要重新生成。
