import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

interface RendererContribution {
  id: string;
  entrypoint: string | { extends: string; path: string };
  requiresMessaging?: string;
}

interface ExtensionManifest {
  activationEvents: string[];
  extensionDependencies: string[];
  contributes: {
    commands: Array<{ command: string; title: string; shortTitle?: string; icon?: string }>;
    notebooks: Array<{
      type: string;
      displayName: string;
      selector: Array<{ filenamePattern: string }>;
      priority: string;
    }>;
    notebookRenderer: RendererContribution[];
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    configuration: {
      properties: Record<string, { default?: unknown; type?: string; description?: string }>;
    };
  };
}

async function manifest(): Promise<ExtensionManifest> {
  const filename = path.resolve(__dirname, "..", "..", "package.json");
  return JSON.parse(await readFile(filename, "utf8")) as ExtensionManifest;
}

test("every renderer messaging channel is contributed and activates its host", async () => {
  const value = await manifest();
  const renderers = new Map(
    value.contributes.notebookRenderer.map((renderer) => [renderer.id, renderer]),
  );
  for (const id of [
    "manimJupyter.video-renderer",
    "manimJupyter.typst-markdown-renderer",
  ]) {
    assert.ok(value.activationEvents.includes(`onRenderer:${id}`));
  }
  assert.equal(renderers.get("manimJupyter.video-renderer")?.requiresMessaging, "always");
  assert.equal(renderers.get("manimJupyter.typst-markdown-renderer")?.requiresMessaging, "always");
  assert.deepEqual(renderers.get("manimJupyter.typst-markdown-renderer")?.entrypoint, {
    extends: "vscode.markdown-it-renderer",
    path: "./renderer/typstMarkdown.js",
  });
});

test("owns only the canonical *.manim.ipynb notebook type", async () => {
  const value = await manifest();
  assert.deepEqual(value.contributes.notebooks, [{
    type: "manim-jupyter-notebook",
    displayName: "Manim Jupyter Notebook",
    selector: [{ filenamePattern: "*.manim.ipynb" }],
    priority: "default",
  }]);
  assert.ok(value.activationEvents.includes("onNotebook:manim-jupyter-notebook"));
  assert.ok(!value.activationEvents.includes("onNotebook:jupyter-notebook"));
  assert.deepEqual(value.extensionDependencies, ["ms-python.python"]);
});

test("notebook renderer entrypoints are valid JavaScript modules", async () => {
  for (const filename of ["renderer/manimVideo.js", "renderer/typstMarkdown.js"]) {
    const source = await readFile(path.resolve(__dirname, "..", "..", filename), "utf8");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${filename}: ${result.stderr}`);
  }
});

test("extension does not depend on private ipynb internals or legacy metadata", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /vscode\.ipynb|custom\.metadata|runStartupCommands/);
  assert.doesNotMatch(source, /openNotebookDocument\(/);
  assert.match(source, /"\*\.manim\.ipynb": NOTEBOOK_TYPE/);
  assert.match(source, /const next = \{ "\*\.manim\.ipynb": NOTEBOOK_TYPE, \.\.\.ordinaryAssociations \}/);
  assert.match(source, /wrongDocument\.isDirty/);
  assert.match(source, /workbench\.action\.closeActiveEditor/);
  assert.match(source, /executeCommand\("vscode\.openWith", uri, NOTEBOOK_TYPE\)/);
});

test("video renderer uses portable bounded chunks instead of typed-array messaging", async () => {
  const host = await readFile(
    path.resolve(__dirname, "..", "..", "src", "videoRenderer.ts"),
    "utf8",
  );
  const renderer = await readFile(
    path.resolve(__dirname, "..", "..", "renderer", "manimVideo.js"),
    "utf8",
  );
  assert.match(host, /chunkBase64/);
  assert.match(renderer, /base64Bytes\(message\.chunkBase64\)/);
  assert.doesNotMatch(host, /chunk:\s*bytes\.buffer/);
  assert.match(host, /MAX_VIDEO_BYTES\s*=\s*128\s*\*\s*1024\s*\*\s*1024/);
  assert.match(renderer, /video\.autoplay = true/);
  assert.match(renderer, /video\.setAttribute\("muted", ""\)/);
  assert.doesNotMatch(renderer, /Boolean\(payload\.autoplay\)/);
  assert.match(renderer, /attemptPlayback\(state\)/);
});

test("quick actions expose configurable video loop separate from PPT loop", async () => {
  const value = await manifest();
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const navigation = await readFile(
    path.resolve(__dirname, "..", "..", "src", "navigationViews.ts"),
    "utf8",
  );
  const renderer = await readFile(
    path.resolve(__dirname, "..", "..", "renderer", "manimVideo.js"),
    "utf8",
  );
  const host = await readFile(
    path.resolve(__dirname, "..", "..", "src", "videoRenderer.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const startup = await readFile(
    path.resolve(__dirname, "..", "..", "python", "manim_jupyter_startup.py"),
    "utf8",
  );
  const config = value.contributes.configuration.properties["manimJupyter.videoLoop"];
  assert.equal(config?.default, false);
  assert.ok(value.contributes.commands.some(
    (command) => command.command === "manimJupyter.toggleVideoLoop",
  ));
  assert.match(navigation, /视频循环播放/);
  assert.match(navigation, /get<boolean>\("videoLoop", false\)/);
  assert.match(extension, /registerCommand\("manimJupyter\.toggleVideoLoop"/);
  assert.match(extension, /videoRenderer\.setVideoLoop\(!current\)/);
  assert.match(runtime, /_MANIM_JUPYTER_BOOTSTRAP\["videoLoop"\]/);
  assert.match(startup, /get\("videoLoop", False\)/);
  assert.match(renderer, /message\?\.type === "setLoop"/);
  assert.match(host, /type: "videoStart", id, size: info\.size, loop: this\.videoLoop\(\)/);
  assert.match(renderer, /message\.loop === undefined/);
});

test("Typst exclusively owns dollar math in Manim Markdown", async () => {
  const value = await manifest();
  const host = await readFile(
    path.resolve(__dirname, "..", "..", "src", "typstMarkdown.ts"),
    "utf8",
  );
  const renderer = await readFile(
    path.resolve(__dirname, "..", "..", "renderer", "typstMarkdown.js"),
    "utf8",
  );
  assert.match(renderer, /token\.type === "math_inline"/);
  assert.match(renderer, /token\.type === "math_block"/);
  assert.match(renderer, /isTypstMathCell\(state\.env\)/);
  assert.match(renderer, /outputItem\.metadata/);
  assert.match(renderer, /manimJupyterTypst/);
  assert.match(renderer, /observedShadowRoots/);
  assert.match(renderer, /classList\.add\("markdown-style"\)/);
  assert.match(renderer, /type:\s*"renderTypst"/);
  assert.match(host, /postMessage\(message, editor\)/);
  assert.match(host, /postMessage\(message\)/);
  assert.match(host, /type:\s*"typstRendered"/);
  assert.match(host, /isManimNotebookPath\(event\.editor\.notebook\.uri\.path\)/);
  assert.match(renderer, /setTimeout\(\(\) => sendRequest/);
  assert.match(renderer, /manim_typst_takeover/);
  const contribution = value.contributes.notebookRenderer.find(
    (item) => item.id === "manimJupyter.typst-markdown-renderer",
  );
  assert.equal(contribution?.requiresMessaging, "always");
});

test("line preview skips slide boundaries and renders at the lowest standard", async () => {
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const core = await readFile(
    path.resolve(__dirname, "..", "..", "src", "core.ts"),
    "utf8",
  );
  assert.match(runtime, /const previewName = "_ManimLinePreview"/);
  assert.match(runtime, /self\.next_slide = lambda \*args, \*\*kwargs: None/);
  // The lowest-standard preview settings live in core.previewRenderSettings.
  assert.match(core, /previewRenderSettings/);
  assert.match(core, /disableCaching: false/);
  assert.match(core, /quality: "l"/);
  // Preview renders the full cumulative Scene: a range-based -n is
  // deliberately not used because static animation counting would disagree
  // with the runtime count whenever self.play appears inside a loop.
  assert.doesNotMatch(runtime, /countManimAnimations/);
});

test("Python, Markdown, and Manim cells have strict independent execution paths", async () => {
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const navigation = await readFile(
    path.resolve(__dirname, "..", "..", "src", "navigationViews.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const companion = await readFile(
    path.resolve(__dirname, "..", "..", "src", "companionPanel.ts"),
    "utf8",
  );
  assert.match(extension, /isManimCellMetadata\(cell\.metadata\)/);
  assert.doesNotMatch(extension, /isManimCellSource/);
  assert.match(runtime, /supportedLanguages = \["python"\]/);
  assert.match(runtime, /const manim = isManimCellMetadata\(cell\.metadata\)/);
  assert.doesNotMatch(companion, /isManimCellSource/);
  assert.match(companion, /!isManimCellMetadata\(cell\.metadata\)/);
});

test("Typst MathML rendering never dirties metadata and presentation uses browser-native Escape", async () => {
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const typst = await readFile(
    path.resolve(__dirname, "..", "..", "src", "typstMarkdown.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  assert.doesNotMatch(extension, /manimJupyterTypstSvgs/);
  assert.doesNotMatch(typst, /updateCellMetadata|workspace\.applyEdit|manimJupyterTypstSvgs/);
  assert.match(typst, /createRendererMessaging/);
  assert.match(typst, /--features", "html"/);
  assert.match(typst, /--format", "html"/);
  assert.match(runtime, /from manim_slides\.convert import RevealJS/);
  assert.match(runtime, /convert_to\(_ManimJupyterPath/);
  assert.match(runtime, /vscode\.env\.openExternal/);
  assert.doesNotMatch(runtime, /ids = \[81, 16777216\]|manim_slides", "--silent", "present"/);
});

test("opening or selecting a saved Manim notebook performs no normalization edit", async () => {
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const serializer = await readFile(
    path.resolve(__dirname, "..", "..", "src", "notebookSerializer.ts"),
    "utf8",
  );
  assert.doesNotMatch(extension, /onDidOpenNotebookDocument/);
  for (const eventName of [
    "onDidChangeActiveNotebookEditor",
    "onDidChangeNotebookEditorSelection",
    "onDidChangeTextEditorSelection",
  ]) {
    const start = extension.indexOf(`vscode.window.${eventName}`);
    assert.ok(start >= 0);
    const handler = extension.slice(start, extension.indexOf("}),", start) + 3);
    assert.doesNotMatch(handler, /maintainManimNotebook|prepareManimNotebook|applyEdit/);
  }
  assert.match(serializer, /canonicalDiskCellMetadata\(record\(cell\.metadata\), kind\)/);
});

test("the extension is standalone from Microsoft Jupyter and uses no proposed API", async () => {
  const value = await manifest() as ExtensionManifest & {
    enabledApiProposals?: string[];
    extensionPack?: string[];
  };
  const packageSource = await readFile(
    path.resolve(__dirname, "..", "..", "package.json"),
    "utf8",
  );
  const productionFiles = [
    "src/extension.ts",
    "src/kernelRuntime.ts",
    "src/notebookSerializer.ts",
    "src/typstMarkdown.ts",
    "src/videoRenderer.ts",
  ];
  const productionSource = (
    await Promise.all(productionFiles.map((filename) =>
      readFile(path.resolve(__dirname, "..", "..", filename), "utf8")
    ))
  ).join("\n");
  assert.deepEqual(value.enabledApiProposals ?? [], []);
  assert.deepEqual(value.extensionPack ?? [], []);
  assert.doesNotMatch(packageSource, /ms-toolsai\.jupyter/i);
  assert.doesNotMatch(productionSource, /notebookKernelSource|notebookVariableProvider|registerKernelSourceActionProvider|createNotebookControllerDetectionTask/);
});

test("product help and rendering are Typst-only", async () => {
  const files = [
    "README.md",
    "src/companionPanel.ts",
    "src/typstMarkdown.ts",
    "renderer/typstMarkdown.js",
  ];
  const source = (
    await Promise.all(files.map((filename) =>
      readFile(path.resolve(__dirname, "..", "..", filename), "utf8")
    ))
  ).join("\n");
  assert.doesNotMatch(source, /MathTex|LaTeX|KaTeX|MathJax/i);
  assert.match(source, /runTypst\(\s*executable/);
});

test("blank Manim notebooks deserialize to a canonical starter scene", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "notebookSerializer.ts"),
    "utf8",
  );
  assert.match(source, /if \(!source\.trim\(\)\)/);
  assert.match(source, /buildSceneCell\("WelcomeScene"\)/);
  assert.match(source, /version:\s*MANIM_NOTEBOOK_SCHEMA_VERSION/);
  assert.match(source, /manimJupyterTypst:\s*true/);
});

test("the Manim notebook toolbar exposes one-click Manim insertion and presentation", async () => {
  const value = await manifest();
  const toolbar = value.contributes.menus["notebook/toolbar"] ?? [];
  const cellTitle = value.contributes.menus["notebook/cell/title"] ?? [];
  assert.ok(toolbar.some((item) => item.command === "manimJupyter.insertManimCell"));
  assert.ok(toolbar.some((item) => item.command === "manimJupyter.playPresentation"));
  assert.ok(!cellTitle.some((item) => item.command === "manimJupyter.insertManimCell"));
  const command = value.contributes.commands.find(
    (candidate) => candidate.command === "manimJupyter.insertManimCell",
  );
  assert.equal(command?.shortTitle, "$(add) Manim");
  assert.equal(command?.icon, "$(add)");
  assert.ok(toolbar.every((item) => item.when?.includes("manim-jupyter-notebook")));
  const toggle = cellTitle.find(
    (item) => item.command === "manimJupyter.changeCodeCellType",
  );
  assert.match(toggle?.group ?? "", /^inline@/);
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const handler = extension.slice(
    extension.indexOf("async function changeCodeCellType"),
    extension.indexOf("function updateActiveCellContext"),
  );
  assert.match(handler, /const toManim = !isManimCell\(cell\)/);
  assert.doesNotMatch(handler, /showQuickPick/);
  assert.match(extension, /defaultAddedCodeCellsToManim/);
  assert.match(extension, /change\.addedCells/);
  assert.match(extension, /manimJupyterCellType === "python"/);
});

test("cell configuration has one entry point and no legacy command alias", async () => {
  const value = await manifest();
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const navigation = await readFile(
    path.resolve(__dirname, "..", "..", "src", "navigationViews.ts"),
    "utf8",
  );
  const commands = value.contributes.commands.map((command) => command.command);
  assert.ok(commands.includes("manimJupyter.configureCell"));
  assert.ok(!commands.includes("manimJupyter.adaptSlideCell"));
  assert.doesNotMatch(extension, /manimJupyter\.adaptSlideCell/);
  assert.match(extension, /class ManimCellStatusBarProvider/);
  assert.match(extension, /registerNotebookCellStatusBarItemProvider/);
  assert.match(extension, /\$\(symbol-structure\) Manim/);
  assert.doesNotMatch(navigation, /配置当前 Cell/);
});

test("contextual help routes Markdown math to Typst and Python to native hovers", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "companionPanel.ts"),
    "utf8",
  );
  assert.match(source, /typstMathContextAtOffset\(fullSource, offset\)/);
  assert.match(source, /panelTitle:\s*"Typst 数学帮助"/);
  assert.match(source, /mode:\s*"typst"/);
  assert.match(source, /"vscode\.executeHoverProvider"/);
  assert.match(source, /panelTitle:\s*"Python 原生帮助"/);
  assert.match(source, /当前内容是 Typst 数学表达式，不会查询 Manim 文档/);
});

test("Typst math in Manim Markdown has local editor completion", async () => {
  const service = await readFile(
    path.resolve(__dirname, "..", "..", "src", "typstMarkdown.ts"),
    "utf8",
  );
  assert.match(service, /registerCompletionItemProvider/);
  assert.match(service, /notebookType:\s*MANIM_NOTEBOOK_TYPE/);
  assert.match(service, /typstMathWordAtOffset\(source, offset\)/);
  assert.match(service, /new vscode\.SnippetString\(suggestion\.insertText\)/);
});

test("Typst preset buttons insert Typst source, not raw Unicode glyphs", async () => {
  const presets = await readFile(
    path.resolve(__dirname, "..", "..", "src", "typstPresetsView.ts"),
    "utf8",
  );
  const math = await readFile(
    path.resolve(__dirname, "..", "..", "src", "typstMath.ts"),
    "utf8",
  );
  assert.match(presets, /data-value="\$\{escapeHtml\(entry\.insertText\)\}"/);
  assert.doesNotMatch(presets, /entry\.value \?\? entry\.glyph/);
  assert.match(presets, /from "\.\/typstMath"/);
  assert.match(math, /symbol\("arrow\.t", "↑"/);
  assert.match(math, /symbol\("parallel", "∥"/);
});

test("Manim cells route the help panel to official Manim docs before Python hover", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "companionPanel.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const manimBranch = source.indexOf("if (isManimCellMetadata(cell.metadata)) {");
  const pythonReturn = source.indexOf('panelTitle: "Python 原生帮助"');
  assert.ok(manimBranch >= 0, "missing manim-cell branch");
  assert.ok(pythonReturn > manimBranch, "python hover must come after manim branch");
  assert.match(source, /typstMathPythonContextAtOffset\(fullSource, offset\)/);
  assert.match(source, /mode: "manim"/);
  assert.match(source, /mode: "python"/);
  // Presentations and cumulative renders collect only Manim cells; Markdown
  // and ordinary Python cells never become slides.
  assert.match(runtime, /filter\(\(cell\) => isManimCellMetadata\(cell\.metadata\)\)/);
});

test("companion preview refreshes local resource roots when notebooks change", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "companionPanel.ts"),
    "utf8",
  );
  assert.match(source, /updateLocalResourceRoots\(cell\?\.notebook\)/);
  assert.match(source, /localResourceRoots:\s*this\.localResourceRoots\(notebook\)/);
  assert.match(source, /path\.dirname\(notebook\.uri\.fsPath\)/);
  assert.match(source, /video\.muted=true;video\.defaultMuted=true/);
  assert.doesNotMatch(source, /empty\.style\.display='block';title\.textContent='点击视频播放'/);
});

test("documentation errors expose their cause and recovery actions", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "companionPanel.ts"),
    "utf8",
  );
  assert.match(source, /doc\.message/);
  assert.match(source, /type:'retryHelp'/);
  assert.match(source, /在浏览器中打开/);
  assert.doesNotMatch(source, /Unable to load the Manim Community documentation/);
});

test("PowerPoint export renders each animation through the private worker", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const startup = await readFile(
    path.resolve(__dirname, "..", "..", "python", "manim_jupyter_startup.py"),
    "utf8",
  );
  const exportBody = source.slice(
    source.indexOf("async function exportPptx"),
    source.indexOf("async function playPresentation"),
  );
  assert.match(exportBody, /kernelRuntime!\.exportPowerPoint\(notebook, destination\.fsPath, token\)/);
  assert.doesNotMatch(exportBody, /kernelRuntime!\.renderPresentation\(notebook\)/);
  assert.doesNotMatch(exportBody, /getCellSettings\(cell\)\.ppt/);
  assert.doesNotMatch(exportBody, /executeCell\(/);
  assert.doesNotMatch(exportBody, /subprocess\.run/);
  const exportImplementation = runtime.slice(
    runtime.indexOf("async exportPowerPoint"),
    runtime.indexOf("async replaceCellOutputs"),
  );
  assert.match(exportImplementation, /combineManimCellSources\(fragments, false\)/);
  assert.doesNotMatch(exportImplementation, /combineManimCellSources\(fragments, true\)/);
  assert.match(exportImplementation, /sceneCommand\(source, settings, false, fragments\[0\]\?\.settings, true\)/);
  assert.match(exportImplementation, /_MANIM_JUPYTER_PPTX_PARTIALS/);
  assert.match(exportImplementation, /_ManimJupyterBuildPptx/);
  assert.doesNotMatch(exportImplementation, /manim_slides.*convert/);
  assert.match(startup, /def _ManimJupyterBuildPptx\(/);
  assert.match(startup, /def _ManimJupyterAutoPlayMedia\(/);
  // The whole timing tree is replaced with PowerPoint's native autoplay
  // structure (mainSeq + onBegin trigger + playFrom) — never a patch on the
  // bare python-pptx tree, which PowerPoint ignores.
  assert.match(startup, /_ManimJupyterTimingXml/);
  assert.match(startup, /playFrom\(0\.0\)/);
  assert.match(startup, /cmd="playFrom/);
  assert.doesNotMatch(startup, /for condition in xpath\(video_node/);
});

test("presentation playback renders one continuous scene and opens Jupyter-style HTML slides", async () => {
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  assert.match(runtime, /async renderPresentation\(/);
  assert.match(runtime, /const fragments = this\.notebookManimFragments\(notebook\)/);
  assert.match(runtime, /combineManimCellSources\(fragments, true\)/);
  assert.match(runtime, /async openHtmlPresentation/);
  assert.match(runtime, /from manim_slides\.convert import RevealJS/);
  assert.match(runtime, /get_scenes_presentation_config/);
  assert.match(runtime, /one_file=False/);
  assert.match(runtime, /slide_number="c\/t"/);
  assert.match(runtime, /transition="none"/);
  assert.match(runtime, /workbench\.action\.toggleZenMode/);
  assert.match(runtime, /enterFullscreen/);
  assert.match(runtime, /exitFullscreen/);
  assert.match(runtime, /panel\.onDidDispose/);
  assert.doesNotMatch(
    runtime.slice(runtime.indexOf("async openHtmlPresentation")),
    /"--to=html"/,
  );
  assert.match(runtime, /vscode\.env\.openExternal/);
  assert.match(runtime, /skip_reversing = False/);
  assert.match(runtime, /return super\(\)\.next_slide/);
  assert.match(extension, /ensureEnvironmentFeature\(notebook, "presentation"\)/);
  assert.match(extension, /kernelRuntime!\.renderPresentation\(notebook\)/);
  assert.match(extension, /kernelRuntime!\.openHtmlPresentation\(notebook, sceneName\)/);
  assert.doesNotMatch(`${runtime}\n${extension}`, /launchManimSlides|renderPresentationCell|--full-screen/);
});

test("the private worker can be interrupted and is released when its notebook closes", async () => {
  const runtime = await readFile(
    path.resolve(__dirname, "..", "..", "src", "kernelRuntime.ts"),
    "utf8",
  );
  const extension = await readFile(
    path.resolve(__dirname, "..", "..", "src", "extension.ts"),
    "utf8",
  );
  assert.match(runtime, /controller\.interruptHandler/);
  assert.match(runtime, /releaseNotebook\(notebook:/);
  assert.match(extension, /onDidCloseNotebookDocument/);
  assert.match(extension, /kernelRuntime\?\.releaseNotebook\(notebook\)/);
});

test("the packaged demo notebook contains no machine-local outputs", async () => {
  const filename = path.resolve(
    __dirname,
    "..",
    "..",
    "examples",
    "demo.manim.ipynb",
  );
  const source = await readFile(filename, "utf8");
  const notebook = JSON.parse(source) as {
    format?: string;
    version?: number;
    cells: Array<{ type: string; execution_count?: number | null; outputs?: unknown[] }>;
  };
  assert.equal(notebook.format, "manim-jupyter");
  assert.equal(notebook.version, 5);
  assert.doesNotMatch(source, /file:\/\/\/|[A-Z]:\\\\Users\\\\/i);
  for (const cell of notebook.cells.filter((candidate) => candidate.type === "code")) {
    assert.equal(cell.execution_count, null);
    assert.deepEqual(cell.outputs, []);
  }
});
