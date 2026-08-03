import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CELL_SETTINGS,
  ManimNotebookSettings,
  animationAtLine,
  buildMagicArguments,
  buildSceneCell,
  canonicalManimCellSource,
  combineManimCellSources,
  countManimAnimations,
  isManimCellSource,
  isManimCellMetadata,
  isManimNotebookPath,
  mathSpanAtOffset,
  notebookManimCellMetadata,
  notebookPythonCellMetadata,
  previewAtLine,
  rawManimCellMetadata,
  rawPythonCellMetadata,
  readManimCellSettings,
  repairRevealConfig,
  sceneNameForBody,
  sanitizeClassName,
} from "../src/core";
import {
  PythonEnvironmentReport,
  missingPackages,
  pipRequirementsForMissing,
} from "../src/environment";
import {
  normalizeTypstMathExpression,
  typstMathContextAtOffset,
  typstMathPythonContextAtOffset,
  typstMathPythonWordAtOffset,
  typstMathSuggestions,
  typstMathWordAtOffset,
} from "../src/typstMath";

test("isolates Manim notebooks from ordinary Jupyter notebooks", () => {
  assert.equal(isManimNotebookPath("lecture.manim.ipynb"), true);
  assert.equal(isManimNotebookPath("LECTURE.MANIM.IPYNB"), true);
  assert.equal(isManimNotebookPath("lecture.ipynb"), false);
  assert.equal(isManimNotebookPath("manim.ipynb"), false);
});

const settings: ManimNotebookSettings = {
  quality: "m",
  renderer: "cairo",
  disableCaching: true,
  mediaWidth: "100%",
  theme: "dark",
  backgroundColor: "#0E1117",
  foregroundColor: "#F8FAFC",
  pixelWidth: 1280,
  aspectRatio: "16:9",
  frameRate: 30,
};

test("uses one canonical body-only Manim Cell format", () => {
  assert.equal(canonicalManimCellSource("\r\nsquare = Square()\r\n"), "square = Square()");
  assert.equal(isManimCellSource("class Demo(Scene):\n    pass"), false);
});

test("uses one canonical metadata schema for *.manim.ipynb", () => {
  assert.equal(DEFAULT_CELL_SETTINGS.autoplay, false);
  const raw = rawManimCellMetadata(DEFAULT_CELL_SETTINGS);
  assert.equal(raw.manimJupyterCellType, "manim");
  assert.deepEqual(raw.slideshow, { slide_type: "slide" });
  assert.equal((raw.manimJupyter as { autoplay?: unknown }).autoplay, false);

  const notebook = notebookManimCellMetadata(
    { execution_count: null, custom: { metadata: { obsolete: true } } },
    DEFAULT_CELL_SETTINGS,
  );
  assert.equal("custom" in notebook, false);
  assert.equal("manimJupyter" in notebook, false);
  assert.equal(isManimCellMetadata(notebook), true);
  assert.deepEqual(readManimCellSettings(notebook), DEFAULT_CELL_SETTINGS);
  assert.equal(readManimCellSettings({ metadata: {} }).autoplay, false);

  const python = rawPythonCellMetadata(raw);
  assert.equal(python.manimJupyterCellType, "python");
  assert.equal("manimJupyter" in python, false);
  assert.deepEqual(python.vscode, { languageId: "python" });
  const livePython = notebookPythonCellMetadata(notebook);
  assert.equal(isManimCellMetadata(livePython), false);
});

test("new scene templates contain only user-facing Manim source", () => {
  const source = buildSceneCell("WelcomeScene", settings);
  assert.match(source, /^title = TypstMath/);
  assert.match(source, /TypstMath/);
  assert.match(source, /self\.play/);
  assert.doesNotMatch(source, /class |def construct|%manim|from manim|config\./);
});

test("recognizes body-only Manim cells without treating ordinary Python as Manim", () => {
  assert.equal(isManimCellSource("circle = Circle()\nself.add(circle)"), true);
  assert.equal(isManimCellSource("value = sum(range(10))"), false);
});

test("locates single-line and multiline animations at the cursor", () => {
  const source = `square = Square()
self.play(Create(square))
self.play(
    square.animate.shift(RIGHT),
    run_time=2,
)
self.wait(1)`;
  assert.deepEqual(animationAtLine(source, 1), {
    index: 0,
    line: 1,
    text: "self.play(Create(square))",
  });
  assert.equal(animationAtLine(source, 4)?.index, 1);
  assert.equal(animationAtLine(source, 6)?.index, 2);
  assert.equal(animationAtLine(source, 0), undefined);
});

test("locates object definitions and placement statements for still previews", () => {
  const source = `title = TypstMath(r"alpha + beta")
title.to_edge(UP)
self.play(Write(title))`;
  assert.deepEqual(previewAtLine(source, 0), {
    kind: "object",
    line: 0,
    endLine: 0,
    text: 'title = TypstMath(r"alpha + beta")',
    objectName: "title",
    sourceThroughStatement: 'title = TypstMath(r"alpha + beta")',
  });
  assert.equal(previewAtLine(source, 1)?.objectName, "title");
  assert.equal(previewAtLine(source, 2)?.kind, "animation");
});

test("keeps a multiline TypstMath assignment together on every cursor line", () => {
  const source = `title = TypstMath(
                         r"sum_(k=1)^n k = (n(n + 1)) / 2"
                         , color=MANIM_FOREGROUND
                       )
self.play(Write(title))`;
  for (const line of [0, 1, 2, 3]) {
    const preview = previewAtLine(source, line);
    assert.equal(preview?.kind, "object");
    assert.equal(preview?.objectName, "title");
    assert.equal(preview?.line, 0);
    assert.equal(preview?.endLine, 3);
    assert.equal(preview?.sourceThroughStatement, source.split("\n").slice(0, 4).join("\n"));
  }
  const animation = previewAtLine(source, 4);
  assert.equal(animation?.kind, "animation");
  assert.equal(animation?.animationIndex, 0);
  assert.equal(animation?.sourceThroughStatement, source);
});

test("finds inline and display Typst math under the Markdown cursor", () => {
  const source = "inline $alpha + beta$\n\n$$\nsum_(k=1)^n k\n$$";
  assert.equal(mathSpanAtOffset(source, source.indexOf("alpha"))?.expression, "alpha + beta");
  const display = mathSpanAtOffset(source, source.indexOf("sum_"));
  assert.equal(display?.display, true);
  assert.equal(display?.expression, "sum_(k=1)^n k");
});

test("Typst math ignores escaped dollars and Markdown code", () => {
  const source = [
    "price \\$5 and `$not_math$`",
    "",
    "```python",
    "$also_not_math$",
    "```",
    "",
    "$alpha + beta$",
  ].join("\n");
  assert.equal(mathSpanAtOffset(source, source.indexOf("not_math")), undefined);
  assert.equal(mathSpanAtOffset(source, source.indexOf("also_not_math")), undefined);
  assert.equal(mathSpanAtOffset(source, source.indexOf("alpha"))?.expression, "alpha + beta");
});

test("normalizes conventional adjacent variables without changing Typst built-ins", () => {
  assert.equal(normalizeTypstMathExpression("E=mc^2"), "E=m c^2");
  assert.equal(
    normalizeTypstMathExpression("integral_a^b f(x) dif x = sqrt(pi)"),
    "integral_a^b f(x) dif x = sqrt(pi)",
  );
});

test("offers offline Typst math completions by aliases", () => {
  const suggestions = typstMathSuggestions("int", 4);
  assert.equal(suggestions[0]?.label, "integral");
  assert.ok(suggestions.some((item) => item.label === "integral.bounds" && item.snippet));
});

test("detects Typst math inside TypstMath(...) strings in Manim cells", () => {
  const source = 'equation = TypstMath(r"sum_(k=1)^n k", color=MANIM_FOREGROUND)';
  const context = typstMathPythonContextAtOffset(source, source.indexOf("sum"));
  assert.ok(context);
  assert.equal(source.slice(context!.contentStart, context!.contentEnd), "sum_(k=1)^n k");
  const word = typstMathPythonWordAtOffset(source, source.indexOf("sum") + 2);
  assert.equal(word?.prefix, "su");
  assert.equal(
    typstMathPythonContextAtOffset("equation = TypstMath(r\"sum\")", 0),
    undefined,
  );
});

test("resolves the TypstMath call containing the cursor", () => {
  const source = 'a = TypstMath(r"alpha")\nb = TypstMath(r"beta")\n';
  const offset = source.indexOf("beta");
  const context = typstMathPythonContextAtOffset(source, offset);
  assert.ok(context);
  assert.equal(source.slice(context!.contentStart, context!.contentEnd), "beta");
  const word = typstMathPythonWordAtOffset(source, offset + 1);
  assert.equal(word?.prefix, "b");
});

test("ignores Typst math delimiters inside Markdown code", () => {
  const source = "```\n$a+b$\n```\nnormal $x$";
  assert.equal(typstMathContextAtOffset(source, source.indexOf("a")), undefined);
  assert.equal(typstMathWordAtOffset(source, source.indexOf("a")), undefined);
  const outside = typstMathContextAtOffset(source, source.indexOf("x"));
  assert.ok(outside);
  assert.equal(source.slice(outside!.contentStart, outside!.contentEnd), "x");
});

test("sanitizes display names into Python class names", () => {
  assert.equal(sanitizeClassName("my first scene"), "MyFirstScene");
  assert.equal(sanitizeClassName("2d demo"), "Scene2dDemo");
});

test("builds whole-cell and one-animation render arguments", () => {
  assert.equal(
    buildMagicArguments("Demo", settings),
    "-qm -r 1280,720 --fps 30 -v WARNING --progress_bar display --renderer=cairo --disable_caching Demo",
  );
  assert.match(buildMagicArguments("Demo", settings, "l", 2), /-n 2,2 Demo$/);
  assert.match(buildMagicArguments("Demo", settings, "l", undefined, true), /--save_last_frame Demo$/);
});

test("combines Manim cells in one persistent Scene and inserts only slide boundaries", () => {
  const first = {
    source: "title = Text('one')\nself.play(Write(title))",
    settings: DEFAULT_CELL_SETTINGS,
  };
  const second = {
    source: "self.play(title.animate.to_edge(UP))",
    settings: { ...DEFAULT_CELL_SETTINGS, autoplay: false },
  };
  const combined = combineManimCellSources([first, second], true);
  assert.match(combined, /title = Text\('one'\)[\s\S]*self\.next_slide\(\)[\s\S]*title\.animate/);
  assert.equal((combined.match(/self\.next_slide\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(combined, /self\.clear|remove\(\*self\.mobjects|class\s+\w+\(Scene\)/);
  assert.equal(countManimAnimations(combined), 2);

  const explicit = combineManimCellSources([
    { ...first, source: `${first.source}\nself.next_slide()` },
    second,
  ], true);
  assert.equal((explicit.match(/self\.next_slide\(\)/g) ?? []).length, 1);

  const preview = combineManimCellSources([first, second], false);
  assert.doesNotMatch(preview, /_manim_jupyter_set_cell_options|next_slide/);
  assert.match(preview, /title\.animate/);
});

test("every slide segment keeps at least one animation and never clears", () => {
  const pureObject = {
    source: "text_1 = Text('I was added with Add!')",
    settings: DEFAULT_CELL_SETTINGS,
  };
  const addOnly = {
    source: "square = Square()\nself.add(square)",
    settings: DEFAULT_CELL_SETTINGS,
  };
  const animated = {
    source: "self.play(Write(title))",
    settings: DEFAULT_CELL_SETTINGS,
  };
  const combined = combineManimCellSources([pureObject, addOnly, animated], true);
  assert.equal((combined.match(/self\.next_slide\(\)/g) ?? []).length, 2);
  assert.equal((combined.match(/self\.wait\(1\.0\)/g) ?? []).length, 2);
  assert.doesNotMatch(combined, /self\.clear/);

  const wholeCell = combineManimCellSources([pureObject, addOnly], false);
  assert.doesNotMatch(wholeCell, /next_slide|self\.wait/);

  const userBoundary = combineManimCellSources([
    { source: "x = Square()\nself.next_slide()", settings: DEFAULT_CELL_SETTINGS },
    animated,
  ], true);
  assert.match(userBoundary, /self\.wait\(1\.0\)[\s\S]*self\.next_slide\(\)/);
  assert.equal((userBoundary.match(/self\.next_slide\(\)/g) ?? []).length, 1);
});

test("repairs unquoted RevealJS config values emitted by manim-slides", () => {
  const repaired = repairRevealConfig(
    "slideNumber: c/t,\nshowSlideNumber: 'all',\ntransition: none, // none/fade/slide/convex/concave/zoom\nmargin: 0.04,\nplugins: [RevealMarkdown, RevealNotes],\n",
  );
  assert.equal(
    repaired,
    "slideNumber: \"c/t\",\nshowSlideNumber: 'all',\ntransition: \"none\", // none/fade/slide/convex/concave/zoom\nmargin: 0.04,\nplugins: [RevealMarkdown, RevealNotes],\n",
  );
});

test("HTML presentation does not require a Qt backend", () => {
  const report: PythonEnvironmentReport = {
    executable: "python",
    pythonVersion: "3.12.0",
    packages: {
      ipython: { installed: true, version: "9.0" },
      ipykernel: { installed: true, version: "7.0" },
      jupyterClient: { installed: true, version: "8.0" },
      manim: { installed: true, version: "0.20" },
      manimSlides: { installed: true, version: "5.6" },
      pythonPptx: { installed: true, version: "1.0" },
    },
    pipAvailable: true,
  };
  assert.deepEqual(missingPackages(report, "runtime"), []);
  assert.deepEqual(missingPackages(report, "presentation"), []);
  assert.deepEqual(pipRequirementsForMissing([]), []);
});
