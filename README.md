# Karen Game Studio

Reusable Agent Skills for game development, visual design, and production
workflows.

## Available skills

| Skill | Purpose |
|---|---|
| `ui-preview-compare` | Compare material UI directions before changing production code. |

## Install

List the skills in this repository:

```bash
npx skills add <github-owner>/karen-game-studio --list
```

Install `ui-preview-compare` globally for Codex:

```bash
npx skills add <github-owner>/karen-game-studio \
  --skill ui-preview-compare \
  --agent codex \
  --global
```

For local development, replace the GitHub repository with this repository's
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
