# Repository instructions

This repository contains independently installable Agent Skills for game
development and adjacent visual workflows, plus local-first browser tools for
preparing game assets.

## Structure

- Keep every skill under `skills/<skill-name>/`.
- Make the directory name match the `name` field in `SKILL.md`.
- Keep each skill self-contained.
- Put executable helpers in that skill's `scripts/` directory.
- Put optional supporting documentation in `references/`.
- Put templates and static resources in `assets/`.
- Do not create empty resource directories.
- Keep every browser tool under `tools/<tool-name>/` with its own `index.html`.
- Keep skills and tools independent of each other.

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

## Tools

- Tools must run by opening `index.html` from `file://`: no build step, no
  network requests, no runtime dependencies. Use plain `<script>` tags, not ES
  modules.
- `ssim.js`, `quantize.js`, `png.js`, `compress.js`, and `zip.js` are duplicated
  byte-for-byte between `tools/aligner/js/` and `tools/matte/js/`. Change both
  copies together.
- Follow the shared design language in `tools/README.md`.
- Run `node --test tests/*.test.js` in the tool's directory before committing.
- Register a new tool on the board in `tools/index.html`.

## Changes

- Update the root skill catalog when adding, renaming, or removing a skill.
- Update the root tool catalog and `tools/README.md` (both languages) when
  adding, renaming, or removing a tool.
- Keep every README in two languages: `README.md` in English (the default) and
  `README.zh-CN.md` in Simplified Chinese, each with a language switcher under
  the title. Update both in the same change.
- Record user-visible behavior changes in `CHANGELOG.md`.
- Preserve existing skill names unless a migration is intentionally planned.
