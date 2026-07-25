# Repository instructions

This repository contains independently installable Agent Skills for game
development and adjacent visual workflows.

## Structure

- Keep every skill under `skills/<skill-name>/`.
- Make the directory name match the `name` field in `SKILL.md`.
- Keep each skill self-contained.
- Put executable helpers in that skill's `scripts/` directory.
- Put optional supporting documentation in `references/`.
- Put templates and static resources in `assets/`.
- Do not create empty resource directories.

## Quality

- Keep trigger descriptions precise and include both positive and negative
  boundaries.
- Check new skills for trigger overlap with existing skills.
- Prefer read-only inspection, reversible operations, and explicit ownership of
  generated artifacts.
- Keep `SKILL.md` concise; move detailed material into directly referenced files.
- Validate frontmatter, referenced files, and local install discovery before
  committing.
- Do not commit generated previews, evaluation output, credentials, caches, or
  machine-specific files.

## Changes

- Update the root skill catalog when adding, renaming, or removing a skill.
- Record user-visible behavior changes in `CHANGELOG.md`.
- Preserve existing skill names unless a migration is intentionally planned.
