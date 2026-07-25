# Karen Game Studio

Open Agent Skills for game development, UI exploration, and production
workflows.

## Quick install

```bash
npx skills add jiehaoZ/karen-game-studio \
  --skill ui-preview-compare
```

The Skills CLI detects compatible coding agents and lets you choose the install
target and scope.

## Available skills

| Skill | Purpose |
|---|---|
| [`ui-preview-compare`](./skills/ui-preview-compare) | Compare UI directions with an AS-IS baseline before changing production code. |

## Example

Ask your coding agent:

> Redesign this inventory screen so players can compare equipment more easily.

When a request contains unresolved visual decisions, `ui-preview-compare` shows
the current AS-IS state and 2–3 clearly differentiated directions before any
production code changes.

## Install options

List every skill in this repository:

```bash
npx skills add jiehaoZ/karen-game-studio --list
```

Add `--global` for a user-wide installation, or use `--agent <agent-name>` to
target a specific compatible agent. For local development, replace
`jiehaoZ/karen-game-studio` with this repository's absolute path.

## Repository structure

Every directory under `skills/` is an independently installable Agent Skill.
Its directory name must match the `name` field in its `SKILL.md`.

```text
skills/
└── ui-preview-compare/
    └── SKILL.md
```

Optional skill-specific scripts, references, and static resources belong inside
that skill's own directory.

## License

MIT
