# Karen Game Studio

Reusable Agent Skills for game development, visual design, and production
workflows. The skills follow the open Agent Skills format and are intended for
compatible coding agents rather than a single vendor or runtime.

## Available skills

| Skill | Purpose |
|---|---|
| `ui-preview-compare` | Compare material UI directions before changing production code. |

## Install

List the skills in this repository:

```bash
npx skills add jiehaoZ/karen-game-studio --list
```

Install `ui-preview-compare`:

```bash
npx skills add jiehaoZ/karen-game-studio \
  --skill ui-preview-compare
```

The Skills CLI detects supported coding agents and lets you choose the install
target and scope. Add `--global` for a user-wide installation, or use
`--agent <agent-name>` when you want to target a specific compatible agent.

For local development, replace `jiehaoZ/karen-game-studio` with this repository's
absolute path.

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
