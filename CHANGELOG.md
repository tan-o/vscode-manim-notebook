# Changelog

## 0.18.0

- Add an independent Scene-class picker to every Manim Cell status item.
- Support slide-aware `Scene`, `ThreeDScene`, `MovingCameraScene`, `ZoomedScene`, `VectorScene`, `LinearTransformationScene`, and `SpecialThreeDScene` rendering.
- Apply the selected Scene class consistently to Cell output, cursor previews, HTML Slides, and PowerPoint export.
- Store the required Scene class in every Manim Cell under the strict v6 schema without a compatibility path.
- Keep adjacent Cells of the same class continuous, and split Cell output, cursor previews, HTML Slides, and PowerPoint at class boundaries.
- Add one combined Notebook containing multi-Cell examples for all seven supported Scene base classes.
- Render static cursor previews with native Manim Scene classes so object-only previews do not create an empty Slides presentation.
- Preserve dotted Typst symbols such as `dots.down` during Markdown math normalization.
- Initialize Typst metadata for Markdown Cells added or converted through VS Code's native Notebook controls.
- Reduce cursor object and animation previews to approximately 240p at 15 fps.
- Separate aspect-ratio, resolution, and frame-rate presets, including independent 4K and 90 fps choices.
- Restore Markdown Typst hover/completion matching and keep native preview Scene bases stable across repeated kernel synchronization.
- Add a renderer-safe SpecialThreeDScene preview base and automatically show Typst formula previews at the editing caret.
- Render caret formula hovers as Typst-generated SVG images so VS Code's Hover sanitizer cannot remove the formula.
- Treat the 15-minute kernel limit as inactivity instead of total render time, reset it on every progress event, and interrupt genuinely stalled work.
- Typeset caret hovers in display-math mode with additional SVG padding so tall operators, limits, and matrices are never clipped.
- Remove the inline MathML overflow container that caused Chromium to show a vertical scrollbar beside tall formulas.

## 0.17.1

- Preserve the exact final state of every PowerPoint animation and hold it for 0.5 seconds inside the same rendered partial movie.
- Stream native render, packaging, and save progress without adding notebook output noise.
- Improve cursor animation previews, including animations invoked through helper functions.
- Keep packaged examples free of machine-local outputs and exclude nested workspace settings from the extension archive.
