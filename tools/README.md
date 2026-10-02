# Game Studio Tool Board

**English** | [简体中文](./README.zh-CN.md)

Small tools that keep coming up when preparing game assets, hung on this board
one at a time.

**Double-click `index.html` in this directory to open the board.** Every tool
runs entirely in the browser: no upload, no network, no environment to install.

Images can be dropped in, picked from a file dialog, or pasted with `⌘V`, so a
screenshot never has to be saved first.

The tools' interface is in Chinese.

## Tools

| Tool | Description | Status |
|------|-------------|--------|
| [Canvas Aligner](aligner/) | Stack n images on one canvas, scale each by hand until the subjects match in size, export a ZIP in one click | Ready |
| [Matte](matte/) | Solid-color background to transparency. Solves the compositing equation, so soft edges and hair are not flattened | Ready |

Both tools compress their exports **until just before the difference becomes
visible**: they step down one level at a time, compare each level against the
original pixel by pixel with structural similarity, and back off one level when
the next step would start to show. PNG reduces the palette size (measured
savings of 72–83%, on par with tinypng.com but without uploading); WebP and JPEG
reduce quality. The search lives in
[`aligner/js/compress.js`](aligner/js/compress.js), and both tools carry the
same copy. The criteria and the pitfalls are written up in the
[Aligner README](aligner/README.md#png-needs-the-search-too-the-knob-is-palette-size-not-quality).

## Adding a tool

Each tool is a standalone directory with its own `index.html`. It runs on a
double-click and depends on nothing else:

```
tools/
├── index.html      tool board (home page)
├── home.css
└── <tool-name>/
    ├── index.html  runs on a double-click
    └── ...
```

Create the directory, write its `index.html`, then replace a
`<li class="tool tool--empty">` in the `.rack` of `tools/index.html` with a tool
card. The board has one empty slot left.

## Shared design language

The board and Canvas Aligner share one visual system. Keep it consistent when
changing either:

| | Used for |
|---|---|
| Warm graphite `#131110` / `#1a1817` | Workbench background, always dark |
| Cool teal `#6fd8ce` | **Only for interactive or currently selected** |
| Amber `#e8a33d` | **Only for fixed markers** (reference frame, peg holes, section labels) |
| Pink `#f05e8e` | Snap guides only |
| `#8a8279` | Darkest allowed secondary text. Any darker falls below WCAG AA 4.5:1 |
| Chivo Mono | Numbers and technical labels; Chinese text uses the system font stack |

The font is embedded in [`aligner/fonts.css`](aligner/fonts.css) (latin subset,
data URI). The home page references that file directly, so it works offline and
is not downloaded twice.

Conceptually this is a studio. Canvas Aligner is the animator's **light table**
(onion skinning comes from stacking cels on backlit glass to register them), and
the home page is the **pegboard** the tools hang on. An empty peg slot is not
whitespace; it is the statement that this collection will grow.
