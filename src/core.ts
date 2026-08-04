import { createHash } from "node:crypto";
import { typstMathSpans } from "./typstMath";

export interface ManimNotebookSettings {
  quality: "l" | "m" | "h" | "p" | "k";
  renderer: "cairo" | "opengl";
  disableCaching: boolean;
  mediaWidth: string;
  theme: "dark" | "light" | "paper" | "blueprint" | "custom";
  backgroundColor: string;
  foregroundColor: string;
  pixelWidth: number;
  aspectRatio: "16:9" | "4:3" | "1:1" | "9:16";
  frameRate: number;
  videoLoop: boolean;
}

export interface ManimCellSettings {
  ppt: boolean;
  autoplay: boolean;
  loop: boolean;
  controls: boolean;
  linePreview: boolean;
  playbackRate: number;
}

export const DEFAULT_CELL_SETTINGS: ManimCellSettings = {
  ppt: true,
  autoplay: false,
  loop: false,
  controls: true,
  linePreview: true,
  playbackRate: 1,
};

function cloneRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value } as Record<string, any>
    : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rawSettings(value: unknown): Partial<ManimCellSettings> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ManimCellSettings>
    : {};
}

export function rawManimCellMetadata(
  options: ManimCellSettings,
): Record<string, unknown> {
  const manimJupyter: Record<string, unknown> = {};
  const keys: Array<keyof ManimCellSettings> = [
    "ppt",
    "autoplay",
    "loop",
    "controls",
    "linePreview",
    "playbackRate",
  ];
  for (const key of keys) {
    if (options[key] !== DEFAULT_CELL_SETTINGS[key]) {
      manimJupyter[key] = options[key];
    }
  }
  return {
    manimJupyter,
  };
}

/**
 * Metadata for a live VS Code NotebookCell. The ipynb serializer keeps the
 * actual on-disk cell metadata in the public `metadata` content field.
 */
export function notebookManimCellMetadata(
  metadata: Record<string, unknown>,
  options: ManimCellSettings,
): Record<string, unknown> {
  const next = cloneRecord(metadata);
  next.metadata = {
    ...cloneRecord(next.metadata),
    ...rawManimCellMetadata(options),
  };
  delete next.custom;
  delete next.manimJupyter;
  delete next.manimJupyterCellType;
  delete next.slideshow;
  return next;
}

export function rawPythonCellMetadata(
  _metadata: Record<string, unknown>,
): Record<string, unknown> {
  return { manimJupyterCellType: "python" };
}

export function notebookPythonCellMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneRecord(metadata);
  next.metadata = rawPythonCellMetadata(cloneRecord(next.metadata));
  delete next.custom;
  delete next.manimJupyter;
  delete next.slideshow;
  return next;
}

export function isManimCellMetadata(metadata: Record<string, unknown>): boolean {
  const disk = record(metadata.metadata);
  return disk.manimJupyter !== undefined;
}

export function readManimCellSettings(
  metadata: Record<string, unknown>,
): ManimCellSettings {
  const value = rawSettings(record(metadata.metadata).manimJupyter);
  return {
    ppt: value.ppt ?? true,
    autoplay: value.autoplay ?? false,
    loop: value.loop ?? false,
    controls: value.controls ?? true,
    linePreview: value.linePreview ?? true,
    playbackRate:
      typeof value.playbackRate === "number" && Number.isFinite(value.playbackRate)
        ? value.playbackRate
        : 1,
  };
}

export function isManimNotebookPath(value: string): boolean {
  return value.toLowerCase().endsWith(".manim.ipynb");
}

const ASPECT_RATIOS: Record<ManimNotebookSettings["aspectRatio"], number> = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "9:16": 9 / 16,
};

/** Longest edge of a companion preview frame, matching Manim's ``-ql`` preset
 * (854×480). Portrait scenes cap their long edge instead, so every aspect
 * stays near 410k pixels instead of growing to e.g. 854×1518 for 9:16. */
export const PREVIEW_MAX_DIMENSION = 854;

/** Preview frame rate, matching Manim's ``-ql`` preset (15 fps). Rendering
 * fewer frames is the cheapest single lever on Cairo rasterization time. */
export const PREVIEW_FRAME_RATE = 15;

/**
 * Lowest-standard settings for companion previews: always ``-ql`` resolution
 * and 15 fps no matter what the notebook settings request, with partial-movie
 * caching kept on so repeated previews of the same Cell stay fast. The preview
 * is displayed stretched to the configured aspect ratio afterwards, so the
 * resolution here only trades speed against pixel density, never the layout.
 */
export function previewRenderSettings(settings: ManimNotebookSettings): ManimNotebookSettings {
  const aspect = ASPECT_RATIOS[settings.aspectRatio];
  return {
    ...settings,
    quality: "l",
    // Long edge ≤ 854: landscape caps the width (854×480), portrait caps the
    // height (480×854 for 9:16). Always near 410k pixels regardless of the
    // configured resolution — the preview is stretched at display time.
    pixelWidth: Math.min(
      settings.pixelWidth,
      Math.round(PREVIEW_MAX_DIMENSION * Math.min(1, aspect)),
    ),
    frameRate: Math.min(settings.frameRate, PREVIEW_FRAME_RATE),
    disableCaching: false,
  };
}

export function sanitizeClassName(value: string): string {
  const words = value
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const candidate = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
    .replace(/^([0-9])/, "Scene$1");
  return candidate || "MyScene";
}

export function isManimCellSource(source: string): boolean {
  return (
    /\bself\.(?:play|wait|add|remove)\s*\(/.test(source) ||
    /^\s*[A-Za-z_]\w*\s*(?::[^=\n]+)?=\s*(?:[A-Z][A-Za-z0-9_]*|VGroup|Group)\s*\(/m.test(source)
  );
}

export function sceneNameForBody(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  return `_ManimCell_${createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 12)}`;
}

export function canonicalManimCellSource(source: string): string {
  return source.replace(/\r\n/g, "\n").trim();
}

export interface ManimCellFragment {
  source: string;
  settings: ManimCellSettings;
}

function endsWithSlideBreak(source: string): boolean {
  const lines = source.split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
  return /^(?:self\.)?next_slide\s*\([^)]*\)\s*;?$/.test(lines.at(-1) ?? "");
}

/**
 * Manim Slides rejects a page that contains zero animations
 * (`start_animation == end_animation`). Split a fragment at every user-written
 * `self.next_slide(...)` boundary and append a one-second hold to any segment
 * that has neither `self.play(...)` nor `self.wait(...)`. Pure object cells
 * therefore become valid slides without clearing anything.
 */
export function ensureSegmentAnimations(source: string): string {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let segment: string[] = [];
  let segmentHasAnimation = false;
  const flush = (): void => {
    if (!segmentHasAnimation && segment.some((line) => line.trim())) {
      output.push(...segment, "self.wait(1.0)");
    } else {
      output.push(...segment);
    }
    segment = [];
    segmentHasAnimation = false;
  };
  for (const line of lines) {
    if (/^\s*self\.next_slide\s*\(/.test(line)) {
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      if (opens === closes && line.trimEnd().endsWith(")")) {
        flush();
        output.push(line);
        continue;
      }
    }
    segment.push(line);
    if (/\bself\.(?:play|wait)\s*\(/.test(line)) {
      segmentHasAnimation = true;
    }
  }
  flush();
  return output.join("\n");
}

function activateCellOptions(settings: ManimCellSettings, replaceOpenSlide: boolean): string {
  const encoded = JSON.stringify(JSON.stringify(settings));
  return `self._manim_jupyter_set_cell_options(_manim_jupyter_json.loads(${encoded}), ${replaceOpenSlide ? "True" : "False"})`;
}

/**
 * Combine Manim Cell bodies into one Scene construct. In presentation mode a
 * PPT-enabled Cell starts a new slide through next_slide(), so every Mobject
 * from the preceding Cell remains in the scene unless user code removes it.
 * Non-presentation mode is a pure body concatenation: the Scene's active
 * settings are applied once by sceneCommand() from the Cell's own options.
 */
export function combineManimCellSources(
  fragments: readonly ManimCellFragment[],
  presentation: boolean,
): string {
  const parts: string[] = [];
  let emittedUserSource = "";
  let hasPresentationCell = false;
  for (const fragment of fragments) {
    const canonical = canonicalManimCellSource(fragment.source);
    const source = presentation ? ensureSegmentAnimations(canonical) : canonical;
    if (!source) continue;
    if (presentation) {
      const needsBoundary = fragment.settings.ppt && hasPresentationCell;
      const boundaryAlreadyOpen = needsBoundary && endsWithSlideBreak(emittedUserSource);
      if (needsBoundary && !boundaryAlreadyOpen) {
        parts.push(activateCellOptions(fragment.settings, false), "self.next_slide()");
      } else {
        parts.push(activateCellOptions(fragment.settings, true));
      }
    }
    parts.push(source);
    emittedUserSource = emittedUserSource ? `${emittedUserSource}\n${source}` : source;
    if (fragment.settings.ppt) hasPresentationCell = true;
  }
  return parts.join("\n\n");
}

export function countManimAnimations(source: string): number {
  return source.match(/\bself\.(?:play|wait)\s*\(/g)?.length ?? 0;
}

export function buildMagicArguments(
  sceneName: string,
  settings: ManimNotebookSettings,
  quality = settings.quality,
  animationRange?: number | { from: number; to: number },
  saveLastFrame = false,
): string {
  const height = Math.round(
    settings.pixelWidth / ASPECT_RATIOS[settings.aspectRatio],
  );
  const parts = [
    `-q${quality}`,
    `-r ${settings.pixelWidth},${height}`,
    `--fps ${settings.frameRate}`,
    "-v WARNING",
    "--progress_bar none",
    `--renderer=${settings.renderer}`,
  ];
  if (settings.disableCaching) {
    parts.push("--disable_caching");
  }
  if (animationRange !== undefined) {
    const from = typeof animationRange === "number" ? animationRange : animationRange.from;
    const to = typeof animationRange === "number" ? animationRange : animationRange.to;
    parts.push(`-n ${from},${to}`);
  }
  if (saveLastFrame) {
    parts.push("--save_last_frame");
  }
  parts.push(sceneName);
  return parts.join(" ");
}

export function buildSceneCell(
  _className: string,
  _settings?: ManimNotebookSettings,
): string {
  return `title = TypstMath(r"sum_(k=1)^n k = (n(n + 1)) / 2", color=MANIM_FOREGROUND)
self.play(Write(title))
self.next_slide()
self.play(title.animate.to_edge(UP))`;
}

export interface AnimationAtLine {
  index: number;
  line: number;
  text: string;
}

export interface PreviewAtLine {
  kind: "animation" | "object";
  line: number;
  endLine: number;
  text: string;
  animationIndex?: number;
  objectName?: string;
  sourceThroughStatement: string;
}

export interface TypstMathSpan {
  expression: string;
  display: boolean;
  start: number;
  end: number;
}

export function mathSpanAtOffset(source: string, offset: number): TypstMathSpan | undefined {
  return typstMathSpans(source).find((span) => offset >= span.start && offset <= span.end);
}

function statementEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  let quote: "'" | '"' | undefined;
  let triple = false;
  for (let line = start; line < lines.length; line += 1) {
    const value = lines[line];
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      const nextThree = value.slice(index, index + 3);
      if (!quote && (nextThree === "'''" || nextThree === '\"\"\"')) {
        quote = nextThree[0] as "'" | '"';
        triple = true;
        index += 2;
        continue;
      }
      if (quote) {
        if (triple && nextThree === quote.repeat(3)) {
          quote = undefined;
          triple = false;
          index += 2;
        } else if (!triple && char === quote && value[index - 1] !== "\\") {
          quote = undefined;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
      } else if (char === "#") {
        break;
      } else if ("([{".includes(char)) {
        depth += 1;
        opened = true;
      } else if (")]}".includes(char)) {
        depth -= 1;
      }
    }
    if (!quote && depth <= 0 && !value.trimEnd().endsWith("\\")) {
      return line;
    }
    if (!opened && !quote) {
      return line;
    }
  }
  return lines.length - 1;
}

/** Locate either an animation or a Mobject definition/placement at the cursor. */
export function previewAtLine(
  source: string,
  cursorLine: number,
): PreviewAtLine | undefined {
  const lines = source.split(/\r?\n/);
  const animation = animationAtLine(source, cursorLine);
  if (animation) {
    const endLine = statementEnd(lines, animation.line);
    return {
      kind: "animation",
      line: animation.line,
      endLine,
      text: animation.text,
      animationIndex: animation.index,
      sourceThroughStatement: lines.slice(0, endLine + 1).join("\n"),
    };
  }

  let callStatement: PreviewAtLine | undefined;
  for (let line = Math.min(cursorLine, lines.length - 1); line >= 0; line -= 1) {
    const endLine = statementEnd(lines, line);
    if (cursorLine > endLine) {
      continue;
    }
    const statement = lines.slice(line, endLine + 1).join("\n");
    const assignment = /^\s*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?!=)/.exec(statement);
    const placement = /^\s*([A-Za-z_]\w*)\.(?:move_to|shift|scale|rotate|next_to|to_edge|to_corner|align_to|set_[A-Za-z_]\w*|arrange)\s*\(/.exec(statement);
    const selfAdd = /^\s*self\.add\s*\(\s*([A-Za-z_]\w*)/.exec(statement);
    const objectName = assignment?.[1] ?? placement?.[1] ?? selfAdd?.[1];
    if (!objectName) {
      // Helper calls are resolved from the Python call stack at runtime.
      if (!callStatement && /^\s*(?:await\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\(/.test(statement)) {
        callStatement = {
          kind: "animation",
          line,
          endLine,
          text: statement.trim(),
          sourceThroughStatement: lines.slice(0, endLine + 1).join("\n"),
        };
      }
      continue;
    }
    return {
      kind: "object",
      line,
      endLine,
      text: statement.trim(),
      objectName,
      sourceThroughStatement: lines.slice(0, endLine + 1).join("\n"),
    };
  }
  return callStatement;
}

/** Locate the self.play/self.wait statement containing the cursor line. */
export function animationAtLine(
  source: string,
  cursorLine: number,
): AnimationAtLine | undefined {
  const lines = source.split(/\r?\n/);
  let animationIndex = -1;
  for (let line = 0; line < lines.length; line += 1) {
    if (!/\bself\.(?:play|wait)\s*\(/.test(lines[line])) {
      continue;
    }
    animationIndex += 1;
    let end = line;
    let depth = 0;
    let opened = false;
    for (; end < lines.length; end += 1) {
      for (const char of lines[end]) {
        if (char === "(") {
          depth += 1;
          opened = true;
        } else if (char === ")") {
          depth -= 1;
        }
      }
      if (opened && depth <= 0) {
        break;
      }
    }
    if (cursorLine >= line && cursorLine <= end) {
      return {
        index: animationIndex,
        line,
        text: lines.slice(line, end + 1).join("\n").trim(),
      };
    }
    line = end;
  }
  return undefined;
}

/**
 * manim-slides 5.6 renders RevealJS config enums (slide_number, transition,
 * ...) without quotes, producing invalid JavaScript such as
 * `slideNumber: c/t,`. Quote every bare lowercase config value so the
 * generated presentation plays both in VS Code and in a plain browser.
 * Some template lines carry a trailing `// ...` comment (e.g.
 * `transition: none, // none/fade/slide/convex/concave/zoom`); the comment
 * must not prevent the quote repair and is preserved.
 */
export function repairRevealConfig(html: string): string {
  const literals = new Set(["true", "false", "null", "undefined", "NaN"]);
  return html.replace(
    /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([a-z][a-z0-9./-]*)\s*,(\s*\/\/.*)?$/gm,
    (_match, indent: string, key: string, value: string, comment: string | undefined) =>
      literals.has(value)
        ? _match
        : `${indent}${key}: "${value}",${comment ?? ""}`,
  );
}
