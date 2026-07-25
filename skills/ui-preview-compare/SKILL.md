---
name: ui-preview-compare
description: Use before implementing a user-visible surface when the request leaves one or more material visual decisions unresolved — such as structure, hierarchy, composition, density, navigation model, or visual language — and choosing the wrong direction would cause meaningful rework. Applies to web pages and components, game-engine UI, Canvas or native-drawn screens, native mobile views, CLI/TUI output, charts, and dashboards, even when the user does not ask for a mockup. Do NOT trigger for an exact design/spec/Figma/reference, a clearly constrained visual bug fix, a named single-property change, routine implementation that is already determined by an existing design system or nearby pattern, or backend/logic work with no visual decision.
---

# UI Preview Compare

## Why this exists

Production UI code makes implicit visual decisions expensive to reverse. This
pre-implementation step renders plausible directions cheaply, lets the user choose,
then hands the chosen intent to the normal implementation workflow.

## Trigger only for a real design decision

Run this skill only when all three statements are true:

1. The task changes something the user will see.
2. At least one **material** visual decision is still open.
3. Existing instructions, references, tokens, and surrounding patterns do not
   already determine the answer.

A material decision changes the shape or experience of the result: navigation,
layout structure, grouping, hierarchy, information density, or visual language.
It is not merely any value that happens to affect pixels.

Use it for requests such as "design a billing page", "make this dashboard easier
to scan", or "make the character cuter" when several valid interpretations remain.
Skip exact Figma implementations, existing-token applications, matching a nearby
pattern, and objectively constrained alignment, overflow, clipping, contrast, or
rendering fixes.

When uncertain, ask: **would two competent designers plausibly produce materially
different answers from the information already available?** If no, implement or
diagnose normally. If yes and the difference matters, preview first.

Once triggered: options first, user picks, then production code. The preview medium
depends on the target; HTML is useful for web UI and wrong for a shader.

## The hard rule: no project code changes until the user signs off

After this skill triggers, do not create, edit, delete, format, or generate files
inside the project until the user reviews the preview and chooses a direction.
Reading and measuring project files is allowed. Put mocks, captures, scripts, and
render output in a task-specific scratch directory outside the project; use a
scratch copy or harness if the real renderer would write caches or build output.

This gate belongs to the workflow; do not claim the user requested it unless they
did. If investigation shows there is no material design choice, exit this skill
and handle the constrained task normally.

## Pick the medium

Choose the cheapest medium that still tells the truth about the real output.

| Target | Useful medium | Typical fidelity |
|---|---|---|
| Web page / component (HTML, React, Vue, WXML) | Self-contained HTML mock, or isolated render of the real component | directional or renderer-faithful |
| Unity **UI Toolkit** (UXML/USS) | Flexbox-only HTML mock, or engine capture | directional or renderer-faithful |
| Unity **uGUI**, **Cocos Creator** UI | HTML mock, or screenshots of engine prefab variants | directional or renderer-faithful |
| Canvas / WeChat mini-game / custom drawing code | Run the real drawing code offscreen against real assets; export PNGs | renderer-faithful |
| 3D scene, particles, shaders, post-processing | Engine screenshots or short captures | renderer-faithful |
| Native mobile (SwiftUI, Compose) | HTML mock at real device width, or native preview capture | directional or renderer-faithful |
| CLI / TUI output | Plain-text mock in `<pre>`, or capture from the real renderer | directional or renderer-faithful |
| Chart / dashboard | Static mock, or render with the real chart library and representative data | directional or renderer-faithful |

Declare fidelity on the comparison page and in the handover:

- **renderer-faithful** — the preview uses the target renderer and representative
  assets/data. Integration, fonts, device scaling, and runtime state can still
  cause small differences; do not promise pixel identity.
- **directional** — the preview medium differs from the real renderer. It settles
  structure, hierarchy, density, and palette; sizes and texture will shift in
  translation.

If 2-3 independent variants are expensive, a before/after pair or two parameter
sets is enough. The decision is the point, not the A/B/C labels.

## The workflow

1. **Confirm the trigger.** Apply the three-part test above. If the answer is
   already determined by a spec, design system, nearby pattern, or objective bug
   constraint, stop using this skill and handle the task normally.

2. **Record a read-only baseline before any preview work.**
   Identify the exact root and capture `git -C <root> status --porcelain=v1`.
   Save diffs to scratch when ownership could become ambiguous. Outside Git, record
   the relevant file list and metadata, but do not treat mtimes alone as proof.
   Manifest every scratch artifact and server process. Avoid commands that generate
   project-local caches, build output, lockfiles, or formatting changes.

3. **Scope the surface and establish AS-IS.** Identify the real content and hard
   constraints (tokens, layout system, brand, density, device size). For an
   existing UI, show its current rendered state first, using the real renderer when
   practical or a source-grounded reproduction otherwise. Label it **AS-IS** and
   declare its fidelity. AS-IS is the baseline, not one of the 2-3 options. Skip it
   only when no current surface exists, it cannot be recovered, or the user
   explicitly wants an unrelated fresh direction; disclose the reason. Use real
   labels, numbers, awkward lengths, and empty states rather than filler.

4. **Name the comparison dimension, then design 2-3 directions.** Put one line on
   the page such as `Comparison dimension: information organization`. Prefer one
   primary dimension — navigation model, layout structure, density, hierarchy,
   interaction model, or visual language — and hold unrelated decisions stable so
   the user's choice has a clear meaning. If two dimensions are inseparable, name
   both; otherwise compare them in separate rounds. Each option must occupy a
   genuinely different, defensible position on the named dimension, not merely
   change color or serve as a strawman.

5. **Render one comparison page.** Wrap any medium in a self-contained HTML page:
   text in `<pre>`, captures in `<img>`. Give exactly one review link.
   - **Preferred — local server.** Allocate an available port, bind only to
     `127.0.0.1`, and serve only the scratch directory. Record PID, port, command,
     and path. Verify process identity before reuse or shutdown; a port number alone
     never identifies a process safely.
   - **Fallback — an absolute local file link.** If a port cannot be bound, provide
     a clickable absolute path. Inline CSS and embed images as `data:` URIs.
   - **Hosted publishing is opt-in only.** If the user explicitly requests a
     shareable URL, give the hosted URL instead; otherwise give only the local link.

   Include `<meta charset="utf-8">`. Show the named comparison dimension, then
   AS-IS before A/B/C when applicable. Label every option and its tradeoff; for
   scoped revisions, make keep/new/changed regions understandable without
   obscuring the design. State fidelity, prevent horizontal body scrolling, and
   keep the page responsive, theme-aware, static, and build-free.

6. **Validate the preview before handoff.**
   Open the selected review target and inspect desktop and narrow viewports. Check
   response/load success, assets, encoding, console errors, body overflow, contrast,
   clipping, and wrapping. State any untested interaction, focus, motion, native
   rendering, or engine-scaling limitations.

7. **Hand over with the project untouched.** Compare current state with the
   baseline. Never revert an existing or ambiguous change; remove only artifacts
   certainly created by this run, and report unclear ownership. Share the single
   link, fidelity, named comparison dimension, option differences, and a brief
   recommendation. Ask which direction to build, including any desired mix of
   options. Then stop and wait.

8. **Implement only after selection.** Translate the chosen intent into idiomatic
   production code; never paste the throwaway HTML. Re-preview a changed direction.
   When the preview is no longer needed, verify and stop its recorded server, then
   remove only its task-specific scratch artifacts.

## Keeping the preview honest

A preview is only useful if it tells the truth about the real constraints:

- Reuse the project's actual tokens, colors, fonts, and assets when they exist — a
  mock in arbitrary colors makes the user choose a look you then can't ship.
- Show the awkward cases: the longest label, the empty state, the overflow row.
  Layouts that look great with tidy sample data break on real data.
- Match the real viewport. A phone screen mocked at desktop width teaches nothing.
- Respect existing accessibility requirements. Check contrast and content
  hierarchy in the preview; disclose keyboard, focus, motion, and assistive
  technology behavior that a static mock cannot verify.
- Know what your medium *can't* say, and don't let the user infer it. HTML can't
  represent nine-slice stretching, bitmap-font rendering, atlas/draw-call limits,
  or engine resolution-fit modes (Canvas Scaler, design-resolution fitWidth /
  fitHeight). If a variant's viability depends on one of those, verify it in the
  engine before recommending it.

## Boundary example

"Make the level-9 blob cuter" triggers because several interpretations are valid;
render the real drawing code from a scratch harness for renderer-faithful options.
"The blob is clipped by 4 px; set its bounds to the documented asset size" does not
trigger because the result is objectively constrained.
