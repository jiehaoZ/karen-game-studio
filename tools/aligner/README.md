# Canvas Aligner

**English** | [简体中文](./README.zh-CN.md)

Stack n images on one canvas, scale each by hand until the subjects match in
size, and export a ZIP in one click.

> One of the tools on the Game Studio board. The board is at
> [`../index.html`](../index.html) ([about](../README.md)), and the "← 工具板"
> link in the top-left corner of the page takes you back at any time. This
> directory can also be copied out and used alone; only that back link stops
> working.

Pure front end, zero dependencies: **double-click `index.html` and it works**.
No environment to install, no server to start, no network. Images never leave
your computer.

The interface is in Chinese. Control names below are given in English with the
on-screen label in parentheses where it helps to find them.

```
┌──────────────────────────────┐
│    ○ ← too small             │   stacked on one canvas
│  ╭───────╮                   │   scale each to fit the frame
│  │  ●    │ ← reference 70%   │   ↓
│  ╰───────╯                   │   n images, same subject size
│  ⬤ ← too large               │
└──────────────────────────────┘
```

## How to use it

1. **Set the canvas size.** Top right, 512×512 by default. The `1:1` button
   locks it to a square.
2. **Drag images in**, or press `⌘V` to paste (a screenshot can be pasted
   without saving it first), or click "导入图片" (Import images) to pick several.
3. **Select the image to adjust in the layer list on the right.** The canvas is
   only for adjusting, not for selecting (see below).
4. **Adjust on the canvas:**

   | Action | How |
   |--------|-----|
   | Scale | **Drag a corner handle**, scroll the wheel (anchored at the cursor), use the slider, or type a value |
   | Move | Drag anywhere on the canvas |
   | Nudge position | Arrow keys; Shift speeds it up to 10px |
   | Nudge scale | `[` and `]` |
   | Delete the selected layer | `Backspace` or `Delete` (`⌘Z` brings it back) |
   | Undo / redo | `⌘Z` / `⇧⌘Z` (`Ctrl` on Windows), or the top bar buttons |

   While dragging a corner, **the opposite corner stays put**: drag the bottom
   right and the top left is pinned. Resizing therefore never makes the image
   drift, and edges are easier to line up than with the wheel.

   While dragging, **the light/dark relationship inverts**: the image being
   dragged turns translucent and all the others turn solid. At that moment you
   are aligning it against the others, so the references should be clear and the
   one being adjusted should get out of the way. Otherwise the image grows as
   you drag and covers exactly what you are aligning to. It reverts on release.

   **Both moving and corner-dragging snap.** Near the canvas center, the
   reference frame edges, or another layer's edges or center, the image clicks
   into place and a pink guide shows what it snapped to. Hold <kbd>Option</kbd>
   to switch it off temporarily, or turn it off for good in the panel.

   **The part outside the canvas is always shown** (translucent, fading
   outward), and the corner handles follow the image out there. Otherwise, once
   an image is larger than the canvas, the part you are dragging is exactly the
   part you cannot see.

5. **Adjust against the reference frame.** Turn the frame on at 70% and scale
   each image's subject to fit it; the n images then share one proportion. The
   frame can be a square or a circle.
6. **Export the ZIP.** Each image is exported as its own file at the full canvas
   size.

## Nine design decisions that are not obvious but matter

### Selection happens only in the layer list; clicking the canvas does not select

Clicking an image on the canvas does **not** change the selected layer. That
sounds backwards, but click-to-select cannot work here: the images are stacked
on purpose and often overlap almost completely, so a click has no defensible
answer for which one you meant. Worse, an image dragged off the canvas could
never be selected again.

So the split is: **the layer list decides which one, the canvas decides how.**
Once a layer is selected, dragging anywhere on the canvas moves that layer,
including when it has gone off the canvas and out of sight. It can still be
dragged back.

### Handles follow the image, including off the canvas

The four corner handles always sit on the layer's real corners, and they leave
the canvas when the image does. This relies on the visible margin around the
canvas (see the section on it below), which gives them somewhere to be drawn and
somewhere to be clicked.

Only when the image is **so far out that it leaves that margin** does a handle
stop at the edge, with a thin ring around it meaning "this handle was moved in".
Any further and it really would be unclickable. In that case **only the handle's
position moved; the scaling pivot did not**. Drag the bottom-right handle and
the pivot is still the real top-left corner, far outside.

The cost is that the canvas is drawn a little smaller than before: the whole
margin has to fit inside the window, or handles outside the window would be just
as unreachable. The "显示 xx%" (display xx%) in the status bar is that zoom
ratio.

### Snapping: why no off-the-shelf library

The capability is common (Figma, Sketch, and Photoshop all have it, as smart
guides or snapping), but **the browser has no native API for it**. It is not a
platform feature the way CSS `scroll-snap` is. Libraries exist, but none of them
is a standalone "snapping" package; each is a whole canvas interaction
framework:

| Library | Unpacked size |
|---|---|
| moveable | 2.4 MB |
| interactjs | 1.4 MB |
| konva | 1.5 MB |
| fabric | 22 MB |

This project already has its own interaction layer (undo, edge-clamped handles,
and blend-mode rendering all hang off it), and adopting any of these would mean
rewriting it. They are also npm packages, while this runs from `file://` with
zero dependencies, so a UMD build would have to be inlined. The algorithm itself
is a few dozen lines; see [`js/snap.js`](js/snap.js).

**The valuable part is the feel, not the algorithm**, and every tool agrees on
these rules:

1. **Snap radius is measured in screen pixels, not canvas pixels.** Otherwise
   the stickiness changes when the view is zoomed.
2. **Always snap the intended position, never an already-snapped one.** Feed the
   snapped result back in and the layer welds to the line: every frame re-snaps
   from inside the radius and the pointer can never escape. Working from the raw
   pointer delta avoids this. The layer releases naturally once it slides past
   the radius, and no separate "escape distance" needs tuning.
3. **Draw what it snapped to.** Otherwise a layer that suddenly jumps looks like
   a bug.
4. **Keep a modifier key that turns it off.** There is always one time it gets
   in the way.

Moving and scaling snap with different math. Moving has two independent axes and
can snap x and y at once. **Scaling has one degree of freedom** (it is uniform):
both coordinates of the corner are functions of the scale, so at most one line
can be satisfied. The corner travels along a ray from the anchor:

```
corner(k) = anchor + (corner0 − anchor) × k,   k = scale / starting scale
```

Landing one coordinate on a line means solving for k, which is a single
division. The nearest line within the radius wins.

### The part outside the canvas is always shown

A translucent preview is drawn around the canvas all the time, not only while
dragging. Without it, an image larger than the canvas has **the part being
dragged be exactly the part that is invisible**, and you can only guess what you
have stretched it into.

It is drawn faint (22%): this ring is what the export will crop away, and it
should not compete with the real picture. The outer edge fades out through a CSS
mask; otherwise the preview would end on a straight hard edge that reads as a
rendering bug rather than "the preview stops here". The canvas's own outline was
brightened to match, since it is now the only boundary between what gets
exported and what gets cropped.

One pitfall in the implementation: canvas `globalAlpha` is **an absolute value,
not cumulative**. Setting it once in the outer scope is overwritten by the
assignment inside `drawLayer`, and the preview became fully opaque. It looked
faint in screenshots purely because of the CSS mask, and it nearly slipped
through. An e2e assertion that reads the actual pixel alpha (255 instead of 56)
caught it. The fade has to be folded into each layer's own alpha.

### Blend mode: why the default is multiply

Images with a solid background, stacked directly, have **the upper image's white
background cover the lower one completely**, and onion skinning stops working.
Lowering the opacity does not help; it only turns everything a hazy gray without
revealing the subject underneath.

Multiply fixes this: white times any color equals that color, so the white
background disappears by itself and several subjects are visible at once.
Dark-background assets use screen, the same principle in reverse. Transparent
PNGs use normal.

On import the edge brightness of the asset is sampled and the mode is chosen
automatically, so this usually needs no attention.

### Compression: the stop condition is quality, not size

The original idea was "keep compressing until the size stops changing".
Measurement showed that this point **does not exist**. On a complex texture,
going from q100 all the way down to q30 still saved 7–15% per step:

```
q100  645.7 KB
q 95  148.7 KB  −77%
q 90  113.7 KB  −24%
q 85   91.9 KB  −19%
 ...
q 35   26.5 KB  −14%
q 30   23.0 KB  −13%      ← still falling; "unchanged" never arrives
```

The size curve has no knee. Stopping on size alone always runs down to the
quality floor, however bad the picture looks by then.

So it stops on quality instead: at every step the result is decoded and compared
with the original pixel by pixel using structural similarity (SSIM), **down to
the point where one more step would start to show, then back one step**. That is
what "compressed as far as it will go" really means.

The result adapts to the content:

| Asset | Stops at | Similarity | Size |
|-------|----------|------------|------|
| Complex texture | q95 | 99.51% | −77% |
| Solid circle | q30 (floor) | 99.91% | −32% |

A secondary brake remains on the size side, for content that truly flattens out
(large areas of solid color), but it is **a conjunction of two conditions**: it
stops only when a step saves both **less than 1 KB** and **less than 0.5%**. A
ratio alone stops too early on large images: 1.9 KB saved on a 400,000-byte
image is only 0.47%, and 1.9 KB is not a rounding error. An absolute value alone
stops on the first step for small images: a 6 KB image cannot save 1 KB at any
step. Only when neither is met has it really stopped giving.

The search also starts from **q95**, not q100. q100 turns off most quantization
and multiplies the size several times over, for a difference no metric can
measure. The first row of the table above is the evidence.

### PNG needs the search too: the knob is palette size, not quality

This section used to say "PNG is lossless, so the compression search does not
apply". That sentence was wrong, and it was the biggest compression mistake in
this tool.

The PNG that canvas produces is **always 32-bit truecolor**; the browser offers
no way to encode with a palette. The assets this tool exports usually have only
a few dozen colors. A measured 512×512 panda has **18 colors in the whole
image** and was stored as 92,649 bytes.

This is also what every online "PNG compression" service does: not a better
deflate, but **color reduction**. So PNG goes through the same descending
search, with the knob swapped for palette size:

| Asset | Before | After | Saved | Stops at |
|-------|--------|-------|-------|----------|
| panda.png | 90.5 KB | 25.2 KB | −72% | 16 colors |
| snake.png | 284.5 KB | 48.5 KB | −83% | 64 colors |
| crocodile.png | 125.4 KB | 26.5 KB | −79% | 64 colors |

The same panda.png uploaded to tinypng.com comes back at 25 KB. It now comes out
at 25.2 KB locally and offline, and the three images take 0.4 seconds in total.

The encoder is hand-written (`png.js`: PLTE + tRNS, packed down to 1/2/4/8 bits
per pixel by palette size), so "can it be read back" was verified for real:
Pillow, macOS `sips`, and Chrome's own decoder were all compared pixel by pixel.

#### Four pitfalls, all of the "looks right" kind

**k-means made the palette worse with every pass.** The standard approach is
median cut followed by a few rounds of k-means to refit. At first that
**lowered** quality: the 32-color result dropped from SSIM 0.961 to 0.838. The
cause was a distance function that multiplied the color error by `min(alpha of
both sides)`. That factor depends on **both** operands, so it is no longer a
metric, the arithmetic mean is no longer the error-minimizing center, and every
k-means round moved away from the optimum. Working in **premultiplied alpha
space** fixed two things at once: the color of transparent pixels goes to zero
naturally (it is multiplied by 0), and the space is still an ordinary weighted
Euclidean space. After the fix k-means reliably lowers the error by 10–14%.

**SSIM was not looking at alpha at all.** The original `toLuma` read only RGB.
The RGB of a transparent pixel is garbage left over from before the matte, and
no encoder preserves it, so the score was penalizing a difference that is
**invisible by definition**, in results where most of the image is transparent.
Luma is now multiplied by alpha first (equivalent to compositing both images
onto black before comparing), and **alpha is additionally compared as its own
channel, taking the worse of the two**.

**Some damage is structurally invisible to SSIM.** This has to be written down,
or it will be repeated:

- When an entire image's alpha goes from 255 to 254, SSIM barely moves. It is
  designed to ignore small uniform shifts. But that makes the whole opaque
  subject translucent, which shows on a light background. The fix is to **snap
  palette entries near 0 and 255 to the endpoints**: those two values are not
  ordinary points on the scale. They mean "something is here" and "nothing is
  here".
- Soft edges crushed into steps: SSIM reported 0.9925 while 254 alpha levels had
  become 4. Within an 8×8 window SSIM sees one quantization step of a gradient
  as a small constant shift, exactly what it is built to ignore. So this
  constraint is **written out directly**: 0.1% of pixels may be exceptions, and
  the rest may not shift in alpha by more than 16/255. A percentile is used
  rather than the maximum. In one measured image the worst pixel shifted by 29
  while the 99.9th percentile shifted by 5, and giving up 4.7× compression for a
  few dozen pixels nobody can find is not worth it.
- A gradient with many steps, each very small, gets past both rules above: 46
  levels spread over the whole gradient, 5.5 apart, undetectable by any
  per-pixel tolerance, yet it looks like concentric rings. **Banding is a
  property of the gradient, not of any single pixel.** What distinguishes it is
  the share of translucent pixels: an ordinary anti-aliased sprite has 0.6–3% (a
  soft edge one or two pixels wide), while a truly soft subject (radial
  gradient, smoke, hair) has over 40%. That is more than an order of magnitude
  apart, so the threshold need not be clever. Above 15% the image is treated as
  a gradient and kept in truecolor. Such images gain the least from color
  reduction anyway.

**The fourth pitfall: do not dither.** Textbooks say to dither, but that advice
is for a fixed palette **given from outside** (web-safe colors, console hardware
palettes), not for a palette fitted to this very image. Measured at every step
of the search, Floyd–Steinberg made the file **15–30% larger** and the SSIM
**lower**, worse in both directions at once. Dithering trades banding for noise,
and noise is the one thing deflate cannot model. The little anti-banding it buys
only matters at steps the similarity floor would reject anyway. The
implementation is kept (`{ dither: true }`) but is not the default.

#### The fifth pitfall, and the most expensive: which box to split depends on how much the split saves

Median cut picks one color box to split at each step. It used to pick the one
with **the largest current total error**. That sounds self-evident, and in
practice it more than doubled the file size for nothing.

Total error is summed over pixels, so it is dominated by **area**: an ocean
covering most of the image, with colors one or two units apart, has a larger
total error than a small region spanning half the gamut. So the ocean was split
once, twice, seven times. In a measured 256×256 image of the Earth, the 28-color
palette had **7 entries crowded into one 6-unit-wide blue cube**, and
neighboring pixels jumped back and forth among those 7 nearly identical entries.
The index stream went from long runs of identical values to noise, and noise is
the one thing deflate cannot compress. The same image:

| | Palette | Horizontal index transitions | File |
|---|---|---|---|
| Split by current error | 28 colors | 17,959 | 12,569 B |
| Split by error saved | 28 colors | 6,526 | **5,405 B** |
| tinypng.com | 28 colors | 7,298 | 5,564 B |

With the criterion changed to **how much error the split removes**, the ocean
drops out by itself: it already equals its own mean, and splitting it saves
nothing. The cut point also changed from the weighted median (a rule about
balance) to **scanning every cut point for the one with the least error** (a
rule about error). With prefix sums it is a single pass, so knowing the optimal
cut costs the same as guessing.

The metric, the ladder, and the stop conditions were untouched; only "who gets
split next" changed. Measured on real images:

| Asset | Before | After | Saved |
|-------|--------|-------|-------|
| earth.png 256×256 | 10.4 KB | 4.7 KB | −55% |
| cover.png 1254×1254 | 198.2 KB | 136.8 KB | −31% |
| balls.png 900×1948 | 157.6 KB | 100.3 KB | −36% |
| Screenshot 1179×2556 | 151.2 KB | 120.3 KB | −20% |

SSIM is essentially unchanged on every row (±0.003), and so is the search time
(+3% on large images).

#### Soft-edge tolerance follows the similarity floor

The 16/255 alpha drift cap above is a conservative number, and it, not SSIM, is
the real brake for soft-edged assets: the Earth image stops at 32 colors with a
drift of only 15, and every step below that is blocked by this cap while SSIM is
still above 0.99.

The reference for how much drift people accept is tinypng: its output for the
same image drifts by **27** at the same percentile, and nobody sees a problem.
So the strict tiers (99.5% / 99% / 98%) keep 16, while **the "最小体积"
(smallest size) tier relaxes to 32**, still below what the industry tool ships.
With smallest size selected, the Earth image goes all the way to 16 colors and
4.7 KB, smaller than tinypng's 5.4 KB with no visible difference.

### Undo reverts edits, not how you look at them

`⌘Z` rolls back the canvas size, each layer's scale and offset, and adding or
removing layers. It does **not** touch the reference frame, opacity, blend mode,
or export settings. Those are how you observe the work, not the work itself.
After moving a layer and then adjusting the reference frame, `⌘Z` should move
the layer back, not make the frame disappear.

Continuous actions merge into one step: one handle drag, one run of wheel
scrolling, one held arrow key each count as a single undo, so you never crawl
back one pixel at a time.

### The export is the original image, not the overlay you see

The stacking, translucency, and blend modes on the canvas are **only for
viewing**. On export each image is rendered alone onto a clean canvas with only
its own scale and offset applied, with no blending or dimming.

## Parameters

| Control | Default | Notes |
|---------|---------|-------|
| Canvas (画布) | 512×512 | Output size, 16–8192px |
| Blend mode | Auto | Multiply (正片叠底) / screen (滤色) / normal (正常) |
| Unselected layer opacity (未选中图层不透明度) | 55% | Strength of the onion skin |
| Show only the selected layer (只显示选中图层) | Off | Isolate one image temporarily to see detail |
| Reference frame (显示参考框) | 70% | Alignment target, square or circle |
| Format | PNG | PNG / WebP / JPEG |
| Similarity floor | 95% (最小体积, smallest size) | Higher means better quality and larger files; PNG uses it too |

## Known limitations

**Quality cannot be rescued at large magnification.** Stretching a 70px subject
to 358px is a 5× enlargement, and the blurred edge band alone is more than ten
pixels wide. The tool does not stop you, but no resampling algorithm can invent
detail. The real fix is to re-export a higher-resolution source.

**JPEG has no alpha channel.** Transparent areas are filled with white when
exporting JPEG. Use WebP or PNG to keep transparency.

**PNG color reduction is lossy, and images with a large share of soft edges skip
it automatically.** The palette has only 256 entries, shared by color and alpha.
Images whose soft edge is the subject itself (radial gradients, smoke, hair) do
not fit; they stay 32-bit truecolor and the log shows "无损" (lossless). Hover
over a log line to see which step each image stopped at.

**Subject alignment is done by eye, not by an algorithm.** This is deliberate:
manual control is the point. The tool does not decide what the subject is; it
only provides the reference frame, snapping, and readouts so you can line it up
yourself.

## Development

```bash
node --test tests/*.test.js      # 187 unit tests, no dependencies
node tests/e2e.mjs               # end to end in a real Chrome (needs playwright)
```

The e2e run really uploads images, really drags the corner handles, really drags
into a snap, really presses `⌘Z`, really deletes an image with `Backspace`, and
really exports, then unzips the ZIP and checks every file's format and
dimensions with `sips`. The hand-written ZIP packer was additionally
cross-checked with the system `ditto` and Python's `zipfile`, including Chinese
filenames.

The hand-written PNG encoder is verified harder, because "the browser happens to
open it" is not the same as "the file is correct". The unit tests parse every
chunk and check each CRC, inflate IDAT, and unpack the scanlines at 1/2/4/8 bits
back into indices to compare with the input (including widths that are not a
whole number of bytes). The e2e run then has **Chrome's own decoder** read back
an image with an alpha gradient and compares it channel by channel.

Test assets are **generated at run time** and not checked in. Nobody can review
a binary file, and it would have to be kept in sync by hand. The code that
generates them also documents which properties of the assets the tests depend on
(white background, a wide enough range of subject sizes).

```
aligner/
├── index.html      structure
├── styles.css      visuals
├── fonts.css       embedded font (Chivo Mono, latin subset, data URI)
└── js/
    ├── state.js    state, immutable updates, undo stack, handle geometry
    ├── render.js   canvas drawing, blend modes
    ├── interact.js dragging, cursor-anchored wheel zoom, keyboard
    ├── snap.js     snapping (separate solutions for move and scale)
    ├── ssim.js     structural similarity (worse of the luma and alpha channels)
    ├── quantize.js color reduction (median cut + k-means, premultiplied alpha)
    ├── png.js      hand-written indexed PNG encoder (PLTE/tRNS/bit-depth packing)
    ├── compress.js compression search (quality steps / palette steps, one stop rule)
    ├── exporter.js layer rendering, naming, and packaging
    ├── zip.js      ZIP packaging (store-only, hand-written)
    └── main.js     wiring
```

The code uses plain `<script>` tags rather than ES modules. That is what lets it
run straight from `file://`, where `import` is blocked by CORS.
