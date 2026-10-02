# Matte

**English** | [简体中文](./README.zh-CN.md)

Turn an image with a solid-color background into one with an alpha channel.
Black, white, and green screen all work, and hair and soft edges are not
flattened.

> One of the tools on the Game Studio board. The board is at
> [`../index.html`](../index.html) ([about](../README.md)), and the "← 工具板"
> link in the top-left corner of the page takes you back at any time.

The interface is in Chinese. Control names below are given in English.

## How to use it

Drag images in (or press `⌘V` to paste) → the background type is detected
automatically → check the result → export a ZIP. Several images can be imported
together, and **each image has its own set of parameters**. Select an image and
press `Backspace` (or `Delete`) to remove it.

Three views at the top can be switched at any time: **Result** (结果, the matted
image), **Alpha** (the transparency itself, in grayscale), and **Original**
(原图). The three buttons beside them change the preview backdrop. **Switching
backdrops matters**: edge residue that is invisible on the checkerboard can be
obvious on pure white.

## Why not use AI for this

Matting a solid-color background has a closed-form solution; no model needs to
guess.

Every composited image satisfies the compositing equation:

```
observed C = α·F + (1−α)·B        F = foreground  B = background  α = opacity
```

With `B` unknown this is three equations in four unknowns, underdetermined, and
**that is exactly why matting models exist**. But for a solid background `B` is
known, and on black the equation collapses to `C = α·F`.

The key difference is not speed. It is that **this never performs
"segmentation" at all**. A segmentation model must answer "does this pixel
belong to the subject", so it can answer wrong, and whiskers, hair, and motion
blur are where it tends to. Solving the equation does not ask that question: if
a hair covers 30% of a pixel, the result is α=0.3, because the formula has
nowhere else to put that value.

The soft-edge test image in the tool exports with **246 distinct alpha values**.
Through a segmentation model there would be only two, 0 and 255.

### An honest limitation

On black, `C = α·F` is still three equations in four unknowns; α and F cannot be
separated. **Only the product α·F is strictly determined** (the premultiplied
color), and every way of splitting it composites back onto black identically.

To report a separate α, the code assumes that the foreground has at least one
channel near full value. Every luma keyer makes this assumption, and it holds
for most assets. When it does not (a dark subject on black), α is
underestimated.

So the tool **derives its thresholds from the image histogram on import**
instead of using fixed defaults: the opaque threshold takes the subject's actual
peak, and the transparent threshold sits just above the background noise. An
orange disc whose peak is only 232, with a fixed 92% default, would export with
a permanent thin layer of transparency. That is not hypothetical; it happened
during development.

## When the inside of the subject matches the background

A panda with black eyes on a black background: **the eyes and the background are
the same color at the pixel level**, and the solved α is identical, 0 for both.
No slider can tell them apart. Any algorithm that looks at single pixels either
keeps both or removes both.

The difference is not color but **position**: the background is the region
connected to the image border, and the eyes are enclosed by the subject. So the
tool flood-fills from the four edges, and **transparent regions the fill cannot
reach are not background** and are given back untouched.

The removal scope (抠除范围) has two options:

| Option | Behavior |
|--------|----------|
| **Background outside the subject** (主体外背景, default) | Removes only the background connected to the image border. The panda's black eyes, or a white collar on a white background, are kept |
| Same color anywhere (全图同色) | Removes every pixel in the image that matches the background color. Use it when the subject really has holes, or to strip one color from a texture |

Two details:

- The **edge** of a hole is a blend of eye and fur, with α in between, so it is
  not itself a hole. Left alone, every eye would export with a faint translucent
  outline, so sealing a hole also eats 2px outward into the transition band.
  That is just enough to cover anti-aliasing without reaching the subject's own
  outline.
- Connectivity is 4-neighbor, not 8-neighbor. 8-neighbor leaks through
  **one-pixel lines running diagonally**, and thin-outlined illustrations are
  exactly the assets that need this feature most.

The same applies to AI matting: the model also gives dark eye sockets a
low-confidence dip, and it is handled the same way.

## Parameters

| Control | Notes |
|---------|-------|
| Background type | Black / white / picked color (including green screen). Detected on import |
| Removal scope | Background outside the subject (default) / same color anywhere; see the previous section |
| Background color | For picked-color mode; can be picked directly on the image |
| Tolerance | In picked-color mode, how far from the background color counts as foreground |
| Transparent threshold | Raise it to clear background noise and compression artifacts |
| Opaque threshold | Lower it to make the subject more solid; dark subjects on black especially need it |
| Despill | Green-screen light spills onto the subject; this pulls it back |

"Apply these parameters to all images" (把这套参数应用到全部图片) saves effort
on a batch from one source, but **do not use it across images from different
sources**. The thresholds are computed per image, and forcing them across throws
away the point of computing them.

## Exports are compressed to just before the difference shows

A matte result is usually **large flat areas plus a ring of soft edge**, which is
exactly the shape a reduced palette handles best. The PNG that canvas produces
is always 32-bit truecolor, the wrong container for such assets: on the same
batch, color reduction typically leaves **20–30%** of the original size.

Both PNG and WebP are compressed step by step. Each step is compared with the
matte output pixel by pixel using structural similarity, and **the search backs
off one step when the next would start to show**. PNG reduces the palette size;
WebP reduces quality. The export log records which step each image stopped at
and how much was saved.

The search implementation and its criteria (including why SSIM cannot see soft
edges crushed into steps, and why images with a large share of soft edges skip
color reduction) are the same `compress.js` that Canvas Aligner uses. The
details are in
[its README](../aligner/README.md#png-needs-the-search-too-the-knob-is-palette-size-not-quality).

One point matters especially for this tool: **images whose soft edges exceed 15%
are not color-reduced.** A 256-entry palette has to hold color and alpha
together. A radial gradient (42% soft edge) squeezed into it keeps only 46 alpha
levels and looks like concentric rings, and preserving that gradient is the
reason this tool exists. Such images stay 32-bit truecolor and the export log
shows "无损" (lossless). Ordinary anti-aliased assets have soft edges of only
0.6–3% and are unaffected.

## When the background is not a solid color

The tool tells you. On import it measures how consistent the edge colors are,
and **if they are not, it says outright that this is not a solid background and
solid-color matting cannot help**, instead of letting you fight the sliders for
ten minutes.

Use AI matting (BiRefNet lite) in that case. **The model does not ship with the
repository.** It asks whether to download only the first time you click "run on
this image", about 109 MB, and is then stored locally in the browser and usable
offline.

### Hard requirements of the AI layer

**WebGPU is required.** This is not a performance optimization; it is whether it
runs at all. The model's input is fixed at 1024×1024, and its intermediate
results exceed what the wasm heap can hold. A pure CPU backend is not slow; the
allocation simply fails. So there is no fallback path: without WebGPU it cannot
be used, and the tool says so before downloading anything.

**About 1 GB of GPU memory is needed.** If there is not enough, it reports
"显存不足" (out of GPU memory) and roughly how much is required.

> **Not verified on real hardware.** The development test environment was a
> headless browser with software rendering, which cannot run this model, so the
> inference path was verified only as far as "model download, caching, and
> session loading all succeed". The final inference step was not measured. The
> first layer (solid-color matting) is fully verified, including pixel-level
> checks of the exported files. If the AI layer fails on your machine, please
> report the error message.

## Known limitations

**Export is PNG and WebP only.** A matte result needs an alpha channel, and JPEG
has none, so it is not offered.

**Images with a large share of soft edges are not compressed.** See the section
above. This is a deliberate trade-off, not something left undone.

**The preview is downsampled.** Images over 1100px are shrunk for preview so the
sliders stay responsive. **Export always uses the original resolution**; the
preview's loss of sharpness never reaches the file.

**Despill only works in picked-color mode.** Black and white backgrounds have no
spill, and changing the value there does nothing.

## Development

```bash
node --test tests/*.test.js    # 64 unit tests, no dependencies
node tests/e2e.mjs             # end to end in a real Chrome (needs playwright)
```

The e2e run draws test images on various backgrounds, really deletes an image
with `Backspace`, really exports a ZIP, and after unzipping **reads the PNG back
and checks the alpha channel pixel by pixel**. It confirms that soft edges
really are gradients rather than hard cuts (the soft-edge test image still has
246 distinct alpha values after export), that the inside of the subject is fully
opaque, and that the background corners are fully transparent.

Those last two assertions guard the compression changes. The first version of
color reduction moved alpha 255 to 254, the whole image became translucent, and
not one of 20,108 solid pixels was left. This assertion caught it; SSIM did not
react at all.

```
matte/
├── index.html
├── styles.css      follows the board's design language
├── fonts.css
└── js/
    ├── key.js      solving the compositing equation: the core
    ├── detect.js   background detection and the "is it solid" decision
    ├── state.js    state, independent parameters per image
    ├── ai.js       on-demand BiRefNet download and inference
    ├── ssim.js     structural similarity  ┐
    ├── quantize.js color reduction        │ these five are
    ├── png.js      indexed PNG            │ byte-identical to
    ├── compress.js compression search     │ the ones in aligner
    ├── zip.js      ZIP packaging          ┘
    └── main.js     wiring
```
