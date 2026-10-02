# Karen Game Studio

A game-development workshop in one repository: Agent Skills for coding agents,
and local-first browser tools for preparing game assets.

| Part | What it is | Where |
|---|---|---|
| Skills | Independently installable Agent Skills | [`skills/`](./skills) |
| Tools | Offline browser tools for game assets | [`tools/`](./tools) |

The two parts are independent. Installing a skill does not pull in the tools,
and the tools run without any agent.

## Skills

| Skill | Purpose |
|---|---|
| [`ui-preview-compare`](./skills/ui-preview-compare) | Compare UI directions with an AS-IS baseline before changing production code. |

### Quick install

```bash
npx skills add jiehaoZ/karen-game-studio \
  --skill ui-preview-compare
```

The Skills CLI detects compatible coding agents and lets you choose the install
target and scope.

### Example

Ask your coding agent:

> Redesign this inventory screen so players can compare equipment more easily.

When a request contains unresolved visual decisions, `ui-preview-compare` shows
the current AS-IS state and 2–3 clearly differentiated directions before any
production code changes.

### Install options

List every skill in this repository:

```bash
npx skills add jiehaoZ/karen-game-studio --list
```

Add `--global` for a user-wide installation, or use `--agent <agent-name>` to
target a specific compatible agent. For local development, replace
`jiehaoZ/karen-game-studio` with this repository's absolute path.

## Tools

| Tool | Purpose |
|---|---|
| [Canvas Aligner](./tools/aligner) | Stack n images on one canvas, scale each subject to match, and export a ZIP. |
| [Matte](./tools/matte) | Turn a solid-color background transparent by solving the compositing equation, so soft edges and hair survive. |

Clone the repository and double-click [`tools/index.html`](./tools/index.html)
to open the tool board. Everything runs in the browser from `file://`: no
upload, no network, no build step, no install. Images can be dropped in, picked,
or pasted with `⌘V`.

Both tools compress exports until one more step would become visible, checking
each step against the original with SSIM. PNG reduces the palette size; WebP and
JPEG reduce quality.

The tool documentation is written in Chinese: see
[`tools/README.md`](./tools/README.md) for the board, the shared design
language, and how to add a tool, and each tool's own README for its design
notes.

### Development

Unit tests need only Node. The end-to-end tests drive a real Chrome through
Playwright, so they need `npm install` in that tool's directory first.

```bash
cd tools/aligner   # or tools/matte
node --test tests/*.test.js
npm install && node tests/e2e.mjs
```

## Repository structure

```text
skills/
└── ui-preview-compare/
    └── SKILL.md
tools/
├── index.html      tool board
├── home.css
├── aligner/        Canvas Aligner
└── matte/          Matte
```

Every directory under `skills/` is an independently installable Agent Skill.
Its directory name must match the `name` field in its `SKILL.md`, and its
scripts, references, and static resources stay inside that directory.

Every directory under `tools/` is a standalone tool with its own `index.html`.

## License

MIT
