import { open, stat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_CELL_SETTINGS,
  ManimCellSettings,
  ManimNotebookSettings,
  buildSceneCell,
  canonicalManimCellSource,
  isManimCellMetadata,
  isManimNotebookPath,
  notebookManimCellMetadata,
  notebookPythonCellMetadata,
  rawManimCellMetadata,
  readManimCellSettings,
  sceneNameForBody,
} from "./core";
import { CompanionPanel } from "./companionPanel";
import { KernelRuntime, MANIM_VIDEO_MIME } from "./kernelRuntime";
import { MANIM_NOTEBOOK_TYPE, ManimNotebookSerializer } from "./notebookSerializer";
import { OperationsTreeProvider } from "./navigationViews";
import { SettingsViewProvider } from "./settingsView";
import { TypstPresetsViewProvider } from "./typstPresetsView";
import { TypstMarkdownService } from "./typstMarkdown";
import { ManimVideoRendererService } from "./videoRenderer";
import {
  EnvironmentFeature,
  PYTHON_PACKAGES,
  PythonEnvironmentReport,
  PythonPackageId,
  missingPackages,
  packageLabels,
  pipRequirementsForMissing,
} from "./environment";

const NOTEBOOK_TYPE = MANIM_NOTEBOOK_TYPE;
const MANIM_NOTEBOOK_SUFFIX = ".manim.ipynb";
const CELL_EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;
let companionPanel: CompanionPanel | undefined;
let kernelRuntime: KernelRuntime | undefined;
let typstMarkdown: TypstMarkdownService | undefined;
const activeNotebookMaintenance = new Map<string, Promise<void>>();

const FEATURE_LABELS: Record<EnvironmentFeature, string> = {
  runtime: "Manim Notebook 运行时",
  presentation: "Jupyter HTML Slides 交互放映",
  powerPoint: "Manim PowerPoint 导出",
};

function isManimNotebook(notebook: vscode.NotebookDocument | undefined): notebook is vscode.NotebookDocument {
  return Boolean(
    notebook &&
    notebook.notebookType === NOTEBOOK_TYPE &&
    isManimNotebookPath(notebook.uri.path),
  );
}

async function ensureManimEditorAssociation(): Promise<void> {
  const workbench = vscode.workspace.getConfiguration("workbench");
  const current = workbench.get<Record<string, string>>("editorAssociations", {});
  // VS Code evaluates overlapping user associations in insertion order in
  // some releases. Keep the specific suffix ahead of the user's broad
  // `*.ipynb -> jupyter-notebook` rule without removing or changing it.
  const { ["*.manim.ipynb"]: _oldManimAssociation, ...ordinaryAssociations } = current;
  const next = { "*.manim.ipynb": NOTEBOOK_TYPE, ...ordinaryAssociations };
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  await workbench.update(
    "editorAssociations",
    next,
    vscode.ConfigurationTarget.Global,
  );
}

async function openManimNotebook(uri: vscode.Uri): Promise<vscode.NotebookDocument> {
  await ensureManimEditorAssociation();
  const sameUri = (candidate: vscode.NotebookDocument) => candidate.uri.toString() === uri.toString();
  const wrongDocument = vscode.workspace.notebookDocuments.find((candidate) =>
    sameUri(candidate) && candidate.notebookType !== NOTEBOOK_TYPE
  );
  if (wrongDocument) {
    if (wrongDocument.isDirty) {
      throw new Error(
        `Close or save the existing Jupyter tab for ${uri.fsPath}, then open it as a Manim Notebook.`,
      );
    }
    await vscode.window.showNotebookDocument(wrongDocument, { preview: false });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    const deadline = Date.now() + 3_000;
    while (vscode.workspace.notebookDocuments.some(sameUri) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await vscode.commands.executeCommand("vscode.openWith", uri, NOTEBOOK_TYPE);
  const deadline = Date.now() + 3_000;
  let document: vscode.NotebookDocument | undefined;
  do {
    document = vscode.workspace.notebookDocuments.find((candidate) =>
      candidate.notebookType === NOTEBOOK_TYPE && sameUri(candidate)
    );
    if (document) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  if (!document) throw new Error(`VS Code did not open ${uri.fsPath} with the Manim Notebook editor.`);
  return document;
}

function settings(): ManimNotebookSettings {
  const config = vscode.workspace.getConfiguration("manimJupyter");
  return {
    quality: config.get<ManimNotebookSettings["quality"]>("quality", "m"),
    renderer: config.get<ManimNotebookSettings["renderer"]>("renderer", "cairo"),
    disableCaching: config.get<boolean>("disableCaching", true),
    mediaWidth: config.get<string>("mediaWidth", "100%"),
    theme: config.get<ManimNotebookSettings["theme"]>("theme", "dark"),
    backgroundColor: config.get<string>("backgroundColor", "#0E1117"),
    foregroundColor: config.get<string>("foregroundColor", "#F8FAFC"),
    pixelWidth: config.get<number>("pixelWidth", 1280),
    aspectRatio: config.get<ManimNotebookSettings["aspectRatio"]>("aspectRatio", "16:9"),
    frameRate: config.get<number>("frameRate", 30),
    videoLoop: config.get<boolean>("videoLoop", false),
  };
}

function metadataWithCellSettings(
  metadata: Record<string, unknown>,
  options: ManimCellSettings,
): Record<string, unknown> {
  return notebookManimCellMetadata(metadata, options);
}

function isManimCell(cell: vscode.NotebookCell): boolean {
  return cell.kind === vscode.NotebookCellKind.Code && isManimCellMetadata(cell.metadata);
}

class ManimCellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
  provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
    if (!isManimCell(cell)) return [];
    const item = new vscode.NotebookCellStatusBarItem(
      "$(symbol-structure) Manim",
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    item.tooltip = "Manim Scene Cell：运行、预览和 PPT 分页由 Manim Jupyter 插件处理";
    item.priority = 100;
    return [item];
  }
}

function getCellSettings(cell: vscode.NotebookCell): ManimCellSettings {
  return readManimCellSettings(cell.metadata);
}

function sceneCellSettings(
  notebook: vscode.NotebookDocument,
): Record<string, ManimCellSettings> {
  const result: Record<string, ManimCellSettings> = {};
  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      continue;
    }
    const source = canonicalManimCellSource(cell.document.getText());
    if (isManimCell(cell)) {
      const sceneName = sceneNameForBody(source);
      result[sceneName] = getCellSettings(cell);
    }
  }
  return result;
}

async function ensureManimRuntime(
  notebook?: vscode.NotebookDocument,
): Promise<void> {
  if (!kernelRuntime || !isManimNotebook(notebook)) {
    return;
  }
  const ready = await kernelRuntime.ensureRuntime(
    notebook,
    settings(),
    sceneCellSettings(notebook),
  );
  void ready;
}

function environmentDetail(report: PythonEnvironmentReport): string {
  const packages = (Object.keys(PYTHON_PACKAGES) as PythonPackageId[]).map((id) => {
    const value = report.packages[id];
    return `${value.installed ? "✓" : "✗"} ${PYTHON_PACKAGES[id].label}${value.version ? ` ${value.version}` : ""}`;
  });
  return [
    `Python ${report.pythonVersion}`,
    report.executable,
    "",
    ...packages,
    `${report.typstPath ? "✓" : "✗"} Typst${report.typstPath ? ` · ${report.typstPath}` : "（不是 Python 包）"}`,
  ].join("\n");
}

async function installMissingEnvironmentPackages(
  notebook: vscode.NotebookDocument,
  report: PythonEnvironmentReport,
  missing: readonly PythonPackageId[],
): Promise<PythonEnvironmentReport | undefined> {
  if (!kernelRuntime) return undefined;
  if (!report.pipAvailable) {
    void vscode.window.showErrorMessage(
      `所选环境没有 pip，无法安装：${packageLabels(missing)}。请先为该 Python 环境安装 pip。`,
    );
    return undefined;
  }
  const requirements = pipRequirementsForMissing(missing);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在为 ${path.basename(path.dirname(report.executable))} 安装缺少的组件`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: requirements.join(" ") });
        await kernelRuntime!.installPythonPackages(notebook, requirements, token);
      },
    );
    const refreshed = await kernelRuntime.inspectEnvironment(notebook);
    void vscode.window.showInformationMessage("所选 Manim Python 环境已补齐。");
    return refreshed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`安装 Python 组件失败：${detail}`);
    return undefined;
  }
}

async function ensureEnvironmentFeature(
  notebook: vscode.NotebookDocument,
  feature: EnvironmentFeature,
): Promise<boolean> {
  if (!kernelRuntime) return false;
  try {
    let report = await kernelRuntime.inspectEnvironment(notebook);
    let missing = missingPackages(report, feature);
    if (!missing.length) return true;
    const install = "安装缺少的 Python 包";
    const documentation = "查看安装说明";
    const choice = await vscode.window.showErrorMessage(
      `${FEATURE_LABELS[feature]} 缺少：${packageLabels(missing)}。`,
      { modal: true, detail: `所选环境：${report.executable}\n\n插件会在渲染任何 Cell 之前检查依赖，避免渲染完成后才失败。` },
      ...(report.pipAvailable ? [install, documentation] : [documentation]),
    );
    if (choice === documentation) {
      await vscode.env.openExternal(vscode.Uri.parse("https://manim-slides.eertmans.be/latest/installation.html"));
      return false;
    }
    if (choice !== install) return false;
    const refreshed = await installMissingEnvironmentPackages(notebook, report, missing);
    if (!refreshed) return false;
    report = refreshed;
    missing = missingPackages(report, feature);
    if (missing.length) {
      void vscode.window.showErrorMessage(`安装后仍缺少：${packageLabels(missing)}。`);
      return false;
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`检查所选 Python 环境失败：${detail}`);
    return false;
  }
}

async function maintainManimNotebook(
  notebook = vscode.window.activeNotebookEditor?.notebook,
): Promise<void> {
  if (!isManimNotebook(notebook)) return;
  const key = notebook.uri.toString();
  const running = activeNotebookMaintenance.get(key);
  if (running) return running;
  const task = (async () => {
    try {
      await prepareManimNotebook(notebook);
    } catch {
      // Notebook normalization remains silent while the editor is restoring.
    }
  })().finally(() => activeNotebookMaintenance.delete(key));
  activeNotebookMaintenance.set(key, task);
  return task;
}

function sceneCell(value: string): vscode.NotebookCellData {
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, value, "python");
  cell.metadata = metadataWithCellSettings({}, DEFAULT_CELL_SETTINGS);
  return cell;
}

async function replaceNotebookCells(
  notebook: vscode.NotebookDocument,
  range: vscode.NotebookRange,
  cells: vscode.NotebookCellData[],
): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(range, cells)]);
  return vscode.workspace.applyEdit(edit);
}

function activeCell(): vscode.NotebookCell | undefined {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isManimNotebook(editor.notebook)) {
    return undefined;
  }
  const index = Math.min(editor.selection.start, editor.notebook.cellCount - 1);
  return index >= 0 ? editor.notebook.cellAt(index) : undefined;
}

async function insertCell(cellArgument?: vscode.NotebookCell): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isManimNotebook(editor.notebook)) {
    void vscode.window.showWarningMessage("请先打开一个 *.manim.ipynb Notebook。");
    return;
  }
  type CellChoice = vscode.QuickPickItem & { cellKind: "manim" | "python" | "markdown" };
  const picked = await vscode.window.showQuickPick<CellChoice>(
    [
      { label: "$(symbol-structure) Manim Cell", description: "对象、位置与动画；自动参与逐行预览和 PPT", cellKind: "manim" },
      { label: "$(code) Python Cell", description: "普通 IPython Cell", cellKind: "python" },
      { label: "$(markdown) Markdown Cell", description: "正文与 Typst 数学公式", cellKind: "markdown" },
    ],
    { title: "插入 Cell", placeHolder: "选择要插入的 Cell 类型" },
  );
  if (!picked) return;
  await insertCellOfKind(picked.cellKind, cellArgument);
}

async function insertCellOfKind(
  kind: "manim" | "python" | "markdown",
  cellArgument?: vscode.NotebookCell,
): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isManimNotebook(editor.notebook)) {
    void vscode.window.showWarningMessage("请先打开一个 *.manim.ipynb Notebook。");
    return;
  }
  const anchor = cellArgument?.notebook === editor.notebook
    ? cellArgument.index + 1
    : editor.selection.end;
  const cell = kind === "manim"
    ? sceneCell("")
    : kind === "python"
      ? new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "python")
      : new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "", "markdown");
  if (kind === "python") {
    cell.metadata = notebookPythonCellMetadata({});
  } else if (kind === "markdown") {
    cell.metadata = { metadata: { manimJupyterTypst: true, slideshow: { slide_type: "skip" } } };
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(anchor, [cell])]);
  if (!await vscode.workspace.applyEdit(edit)) {
    void vscode.window.showErrorMessage("没有插入 Cell；Notebook 拒绝了本次编辑。");
  }
}

async function insertManimCell(cellArgument?: vscode.NotebookCell): Promise<void> {
  await insertCellOfKind("manim", cellArgument);
}

async function defaultAddedCodeCellsToManim(
  event: vscode.NotebookDocumentChangeEvent,
): Promise<void> {
  if (!isManimNotebook(event.notebook)) return;
  const edits: vscode.NotebookEdit[] = [];
  for (const change of event.contentChanges) {
    for (const cell of change.addedCells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      const diskMetadata = cell.metadata.metadata && typeof cell.metadata.metadata === "object"
        ? cell.metadata.metadata as Record<string, unknown>
        : {};
      if (diskMetadata.manimJupyterCellType === "manim" || diskMetadata.manimJupyterCellType === "python") {
        continue;
      }
      edits.push(vscode.NotebookEdit.updateCellMetadata(
        cell.index,
        metadataWithCellSettings(cell.metadata, DEFAULT_CELL_SETTINGS),
      ));
    }
  }
  if (!edits.length) return;
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(event.notebook.uri, edits);
  await vscode.workspace.applyEdit(workspaceEdit);
}

async function changeCodeCellType(cellArgument?: vscode.NotebookCell): Promise<void> {
  const cell = cellArgument ?? activeCell();
  if (!cell || cell.kind !== vscode.NotebookCellKind.Code || !isManimNotebook(cell.notebook)) {
    void vscode.window.showWarningMessage("请选择一个 Python 或 Manim 代码 Cell。");
    return;
  }
  const toManim = !isManimCell(cell);
  const metadata = toManim
    ? metadataWithCellSettings(cell.metadata, getCellSettings(cell))
    : notebookPythonCellMetadata(cell.metadata);
  const edit = new vscode.WorkspaceEdit();
  edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, metadata)]);
  if (!await vscode.workspace.applyEdit(edit)) {
    void vscode.window.showErrorMessage("无法更改 Cell 类型。");
    return;
  }
  if (cell.document.languageId !== "python") {
    await vscode.languages.setTextDocumentLanguage(cell.document, "python");
  }
  updateActiveCellContext();
  void maintainManimNotebook(cell.notebook);
  companionPanel?.refresh(true);
  vscode.window.setStatusBarMessage(
    `Cell ${cell.index + 1} 已转换为 ${toManim ? "Manim" : "Python"} Cell`,
    2_000,
  );
}

function updateActiveCellContext(): void {
  const cell = activeCell();
  void vscode.commands.executeCommand(
    "setContext",
    "manimJupyter.isManimNotebook",
    isManimNotebook(vscode.window.activeNotebookEditor?.notebook),
  );
  void vscode.commands.executeCommand(
    "setContext",
    "manimJupyter.isManimCell",
    Boolean(cell && isManimCell(cell)),
  );
}

async function prepareManimNotebook(notebook: vscode.NotebookDocument): Promise<void> {
  if (!isManimNotebook(notebook)) {
    return;
  }
  const notebookEdits: vscode.NotebookEdit[] = [];
  for (const cell of notebook.getCells()) {
    const manim = cell.kind === vscode.NotebookCellKind.Code && isManimCell(cell);
    const metadata = manim
      ? metadataWithCellSettings(cell.metadata, getCellSettings(cell))
      : cell.kind === vscode.NotebookCellKind.Markup
        ? {
          ...cell.metadata,
          metadata: {
            ...(cell.metadata.metadata && typeof cell.metadata.metadata === "object"
              ? cell.metadata.metadata as Record<string, unknown>
              : {}),
            manimJupyterTypst: true,
            slideshow: { slide_type: "skip" },
          },
        }
        : notebookPythonCellMetadata(cell.metadata);
    if (JSON.stringify(metadata) !== JSON.stringify(cell.metadata)) {
      notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, metadata));
    }
  }
  if (notebookEdits.length) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, notebookEdits);
    await vscode.workspace.applyEdit(edit);
  }
}

async function newNotebook(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const destination = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, `untitled${MANIM_NOTEBOOK_SUFFIX}`) : undefined,
    filters: { "Manim Notebook": ["ipynb"] },
    saveLabel: "新建 Manim Notebook",
  });
  if (!destination) return;
  const target = destination.path.toLowerCase().endsWith(MANIM_NOTEBOOK_SUFFIX)
    ? destination
    : destination.with({ path: destination.path.replace(/\.ipynb$/i, "") + MANIM_NOTEBOOK_SUFFIX });
  const source = buildSceneCell("WelcomeScene");
  const contents = {
    cells: [{
      cell_type: "code",
      execution_count: null,
      metadata: rawManimCellMetadata(DEFAULT_CELL_SETTINGS),
      outputs: [],
      source: source.split(/(?<=\n)/),
    }],
    metadata: {
      manimJupyter: { version: 4, oneCellOneSlide: true },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(contents, null, 2), "utf8"));
  await openManimNotebook(target);
  companionPanel?.show();
  void vscode.window.showInformationMessage(
    "Manim Notebook 已创建：Cell 只保留场景源码，运行与 PPT 分页由后台自动完成。",
  );
}

async function openNotebook(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Manim Notebook (*.manim.ipynb)": ["ipynb"] },
    openLabel: "打开 Manim Notebook",
  });
  if (!selected?.[0]) {
    return;
  }
  if (!selected[0].path.toLowerCase().endsWith(MANIM_NOTEBOOK_SUFFIX)) {
    void vscode.window.showWarningMessage("这里只打开 *.manim.ipynb；普通 *.ipynb 请直接使用 Microsoft Jupyter。 ");
    return;
  }
  await openManimNotebook(selected[0]);
  companionPanel?.show();
}

function executionKey(summary: vscode.NotebookCellExecutionSummary | undefined): string {
  return JSON.stringify({
    order: summary?.executionOrder,
    success: summary?.success,
    start: summary?.timing?.startTime,
    end: summary?.timing?.endTime,
  });
}

async function executeCell(cell: vscode.NotebookCell): Promise<vscode.NotebookCell> {
  const notebook = cell.notebook;
  const cellIndex = cell.index;
  const previousKey = executionKey(cell.executionSummary);
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let subscription: vscode.Disposable | undefined;

  const completion = new Promise<vscode.NotebookCell>((resolve, reject) => {
    const inspect = (candidate: vscode.NotebookCell): void => {
      const summary = candidate.executionSummary;
      if (
        settled ||
        typeof summary?.success !== "boolean" ||
        executionKey(summary) === previousKey
      ) {
        return;
      }
      settled = true;
      if (summary.success) {
        resolve(candidate);
      } else {
        reject(new Error(`Cell ${cellIndex + 1} 执行失败，请查看该 Cell 的错误输出。`));
      }
    };
    subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return;
      const changed = event.cellChanges.find((change) => change.cell.index === cellIndex);
      if (changed?.executionSummary) inspect(changed.cell);
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Cell ${cellIndex + 1} 渲染超过 15 分钟，已停止等待。`));
    }, CELL_EXECUTION_TIMEOUT_MS);
  });

  try {
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(cellIndex, cellIndex + 1)],
      document: notebook.uri,
    });
    const current = notebook.cellAt(cellIndex);
    if (
      !settled &&
      typeof current.executionSummary?.success === "boolean" &&
      executionKey(current.executionSummary) !== previousKey
    ) {
      settled = true;
      if (!current.executionSummary.success) {
        throw new Error(`Cell ${cellIndex + 1} 执行失败，请查看该 Cell 的错误输出。`);
      }
      return current;
    }
    return await completion;
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.dispose();
  }
}

interface ManimVideoDescriptor {
  path: string;
}

function videoDescriptor(cell: vscode.NotebookCell): ManimVideoDescriptor | undefined {
  for (const output of [...cell.outputs].reverse()) {
    const item = output.items.find((candidate) => candidate.mime === MANIM_VIDEO_MIME);
    if (!item) continue;
    try {
      const parsed = JSON.parse(Buffer.from(item.data).toString("utf8")) as Partial<ManimVideoDescriptor>;
      if (typeof parsed.path === "string" && parsed.path.trim()) {
        return { path: parsed.path };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function verifyRenderedVideo(cell: vscode.NotebookCell): Promise<void> {
  const descriptor = videoDescriptor(cell);
  await verifyVideoDescriptor(descriptor, cell.index);
}

async function verifyVideoDescriptor(
  descriptor: ManimVideoDescriptor | undefined,
  cellIndex: number,
): Promise<void> {
  if (!descriptor) {
    throw new Error(`Cell ${cellIndex + 1} 没有产生 Manim 视频，请查看该 Cell 的错误输出。`);
  }
  const resolved = path.resolve(descriptor.path);
  const info = await stat(resolved);
  if (!info.isFile() || info.size < 16) {
    throw new Error(`Cell ${cellIndex + 1} 产生的视频文件为空或不完整。`);
  }
  const handle = await open(resolved, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const isWebM = bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const isIsoMedia = bytesRead >= 8 && header.subarray(4, 8).toString("ascii") === "ftyp";
    if (!isWebM && !isIsoMedia) {
      throw new Error(`Cell ${cellIndex + 1} 产生的文件不是有效的 MP4/WebM 视频。`);
    }
  } finally {
    await handle.close();
  }
}

async function renderCell(cellArgument?: vscode.NotebookCell): Promise<void> {
  const cell = cellArgument ?? activeCell();
  if (!cell || !isManimCell(cell)) {
    void vscode.window.showWarningMessage("请选择一个包含 Manim 动画语句的 Cell。");
    return;
  }
  await prepareManimNotebook(cell.notebook);
  await ensureManimRuntime(cell.notebook);
  try {
    const rendered = await executeCell(cell.notebook.cellAt(cell.index));
    await verifyRenderedVideo(rendered);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Manim 渲染失败：${detail}`);
  }
}

async function insertTypstPreset(snippet: string): Promise<void> {
  const cell = activeCell();
  if (!cell) {
    void vscode.window.showWarningMessage("请先选择一个 Manim Cell 或 Markdown Cell。");
    return;
  }
  const editor = vscode.window.visibleTextEditors.find(
    (candidate) => candidate.document.uri.toString() === cell.document.uri.toString(),
  );
  if (!editor) {
    void vscode.window.showWarningMessage(
      "请先在 Cell 中点一下，把光标放进 TypstMath(r\"...\") 或 Markdown 的 $...$ 中。",
    );
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(snippet), editor.selection.active);
}

async function syncActiveNotebookSceneCells(): Promise<void> {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!isManimNotebook(notebook)) {
    return;
  }
  await prepareManimNotebook(notebook);
  await ensureManimRuntime(notebook);
  const ready = await kernelRuntime?.ensureRuntime(
    notebook,
    settings(),
    sceneCellSettings(notebook),
  );
  if (ready) {
    await kernelRuntime?.syncRuntime(notebook, settings(), sceneCellSettings(notebook));
  }
}

async function configureCell(cellArgument?: vscode.NotebookCell): Promise<void> {
  const cell = cellArgument ?? activeCell();
  if (!cell || !isManimCell(cell)) {
    void vscode.window.showWarningMessage("请选择一个 Manim Scene Cell。");
    return;
  }
  const current = getCellSettings(cell);
  type ToggleKey = "ppt" | "autoplay" | "loop" | "controls" | "linePreview";
  const choices: Array<vscode.QuickPickItem & { key: ToggleKey }> = [
    { key: "ppt", label: "$(presentation) 此 Cell 开启新页", description: "在同一 Scene 中插入 next_slide()，不清空对象", picked: current.ppt },
    { key: "autoplay", label: "$(play-circle) HTML Slides 自动继续", description: "Cell 输出和预览始终自动播放；此选项只控制 HTML Slides 是否自动切到下一页", picked: current.autoplay },
    { key: "loop", label: "$(debug-restart) PPT 循环播放", description: "HTML Slides 页面循环；视频循环请在快捷操作中切换", picked: current.loop },
    { key: "controls", label: "$(settings) 显示视频控件", description: "右侧语句预览显示控制条", picked: current.controls },
    { key: "linePreview", label: "$(open-preview) 对象与动画预览", description: "光标移动后自动低清渲染对象、位置或动画", picked: current.linePreview },
  ];
  const selected = await vscode.window.showQuickPick(choices, {
    title: `Cell ${cell.index + 1} · Manim / PPT 设置`,
    placeHolder: "勾选要启用的功能",
    canPickMany: true,
  });
  if (!selected) {
    return;
  }
  const enabled = new Set(selected.map((item) => item.key));
  const rateText = await vscode.window.showInputBox({
    title: "HTML Slides 播放速度",
    prompt: "1 为原速；0.5 为半速；2 为两倍速（PowerPoint 中由 PowerPoint 控制媒体速度）",
    value: String(current.playbackRate),
    validateInput: (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number <= 8
        ? undefined
        : "请输入 0 到 8 之间的数字。";
    },
  });
  if (rateText === undefined) {
    return;
  }
  const next: ManimCellSettings = {
    ppt: enabled.has("ppt"),
    autoplay: enabled.has("autoplay"),
    loop: enabled.has("loop"),
    controls: enabled.has("controls"),
    linePreview: enabled.has("linePreview"),
    playbackRate: Number(rateText),
  };
  const edit = new vscode.WorkspaceEdit();
  edit.set(cell.notebook.uri, [
    vscode.NotebookEdit.updateCellMetadata(
      cell.index,
      metadataWithCellSettings(cell.metadata, next),
    ),
  ]);
  await vscode.workspace.applyEdit(edit);
  await ensureManimRuntime(cell.notebook);
  const ready = await kernelRuntime?.ensureRuntime(
    cell.notebook,
    settings(),
    sceneCellSettings(cell.notebook),
  );
  if (ready) {
    await kernelRuntime?.syncRuntime(
      cell.notebook,
      settings(),
      sceneCellSettings(cell.notebook),
    );
  }
  companionPanel?.refresh(true);
}

async function exportPptx(): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isManimNotebook(editor.notebook)) {
    void vscode.window.showWarningMessage("请先打开一个 *.manim.ipynb Notebook。");
    return;
  }
  const notebook = editor.notebook;
  await prepareManimNotebook(notebook);
  const cells = notebook.getCells().filter((cell) => isManimCell(cell));
  if (!cells.length) {
    void vscode.window.showWarningMessage("当前 Notebook 没有可导出的 Manim Cell。");
    return;
  }
  if (!await ensureEnvironmentFeature(notebook, "powerPoint")) return;
  const defaultFolder = notebook.isUntitled
    ? vscode.workspace.workspaceFolders?.[0]?.uri
    : vscode.Uri.file(path.dirname(notebook.uri.fsPath));
  const baseName = notebook.isUntitled
    ? "manim-presentation"
    : path.basename(notebook.uri.fsPath, path.extname(notebook.uri.fsPath));
  const destination = await vscode.window.showSaveDialog({
    defaultUri: defaultFolder
      ? vscode.Uri.joinPath(defaultFolder, `${baseName}.pptx`)
      : undefined,
    filters: { PowerPoint: ["pptx"] },
    saveLabel: "导出 Manim PowerPoint",
  });
  if (!destination) {
    return;
  }
  try {
    const ready = await kernelRuntime?.ensureRuntime(
      notebook,
      settings(),
      sceneCellSettings(notebook),
    );
    if (!ready) {
      void vscode.window.showWarningMessage("请先在 Notebook 右上角选择一个 Python 环境。");
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在渲染 Manim 并导出 PowerPoint",
        cancellable: true,
      },
      async (progress, token) => {
        if (token.isCancellationRequested) throw new Error("已取消 PowerPoint 导出。");
        progress.report({ message: "逐动画渲染并合成每页视频", increment: 80 });
        await kernelRuntime!.exportPowerPoint(notebook, destination.fsPath, token);
      },
    );
    void vscode.window.showInformationMessage(
      `已按 Manim 动画逐页导出（每页自动播放）：${destination.fsPath}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`PowerPoint 导出失败：${detail}`);
  }
}

async function playPresentation(): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isManimNotebook(editor.notebook)) {
    void vscode.window.showWarningMessage("请先打开一个 *.manim.ipynb Notebook。");
    return;
  }
  const notebook = editor.notebook;
  await prepareManimNotebook(notebook);
  if (!notebook.cellCount) {
    void vscode.window.showWarningMessage("当前 Notebook 没有可以放映的 Cell。");
    return;
  }
  if (!await ensureEnvironmentFeature(notebook, "presentation")) return;
  const manimCells = notebook.getCells().filter((cell) => isManimCell(cell));
  if (!manimCells.some((cell) => getCellSettings(cell).ppt)) {
    void vscode.window.showWarningMessage("当前 Notebook 没有启用 PPT 的 Manim Cell。");
    return;
  }
  try {
    const ready = await kernelRuntime?.ensureRuntime(
      notebook,
      settings(),
      sceneCellSettings(notebook),
    );
    if (!ready) {
      void vscode.window.showWarningMessage("请先在 Notebook 右上角选择一个 Python 环境。");
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在准备 Jupyter HTML Slides 交互放映",
        cancellable: true,
      },
      async (progress, token) => {
        if (token.isCancellationRequested) throw new Error("已取消播放准备。");
        progress.report({ message: "连续渲染全部 Manim Cell", increment: 80 });
        const sceneName = await kernelRuntime!.renderPresentation(notebook);
        if (token.isCancellationRequested) throw new Error("已取消播放准备。");
        progress.report({ message: "生成并打开 Jupyter HTML Slides", increment: 20 });
        await kernelRuntime!.openHtmlPresentation(notebook, sceneName);
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Jupyter HTML Slides 放映失败：${detail}`);
  }
}

async function checkKernel(): Promise<void> {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!isManimNotebook(notebook)) {
    void vscode.window.showWarningMessage("请先打开一个 *.manim.ipynb Notebook。");
    return;
  }
  if (!kernelRuntime) return;
  try {
    let report = await kernelRuntime.inspectEnvironment(notebook);
    const allMissing = Array.from(new Set([
      ...missingPackages(report, "presentation"),
      ...missingPackages(report, "powerPoint"),
    ]));
    const install = "安装缺少的 Python 包";
    const choice = allMissing.length
      ? await vscode.window.showWarningMessage(
          `所选环境缺少 ${packageLabels(allMissing)}。`,
          { modal: true, detail: environmentDetail(report) },
          ...(report.pipAvailable ? [install] : []),
        )
      : await vscode.window.showInformationMessage(
          "所选环境已具备 Manim、Jupyter HTML Slides 放映与 PowerPoint 导出能力。",
          { modal: true, detail: environmentDetail(report) },
        );
    if (choice === install) {
      const refreshed = await installMissingEnvironmentPackages(notebook, report, allMissing);
      if (refreshed) report = refreshed;
    }
    if (!missingPackages(report, "runtime").length) {
      await kernelRuntime.ensureRuntime(notebook, settings(), sceneCellSettings(notebook));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Manim 环境检查失败：${detail}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  void ensureManimEditorAssociation().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Unable to register *.manim.ipynb editor: ${detail}`);
  });
  kernelRuntime = new KernelRuntime(
    vscode.Uri.joinPath(context.extensionUri, "python", "manim_jupyter_startup.py"),
    vscode.Uri.joinPath(context.extensionUri, "python", "manim_kernel_worker.py"),
    NOTEBOOK_TYPE,
    settings,
    sceneCellSettings,
  );
  companionPanel = new CompanionPanel(
    context.extensionUri,
    vscode.Uri.joinPath(context.globalStorageUri, "official-docs"),
    async (cell, line) =>
      kernelRuntime?.renderLine(
        cell,
        line,
        settings(),
        getCellSettings(cell),
        sceneCellSettings(cell.notebook),
      ),
    getCellSettings,
  );
  const settingsView = new SettingsViewProvider(
    settings,
    syncActiveNotebookSceneCells,
    () => companionPanel?.show(),
  );
  const typstView = new TypstPresetsViewProvider(insertTypstPreset);
  const manimCellStatusBar = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
    NOTEBOOK_TYPE,
    new ManimCellStatusBarProvider(),
  );
  typstMarkdown = new TypstMarkdownService(
    (notebook) => kernelRuntime?.resolveTypstExecutable(notebook),
  );
  const videoRenderer = new ManimVideoRendererService();
  const operationsProvider = new OperationsTreeProvider();
  const operationsView = vscode.window.createTreeView("manimJupyter.operations", {
    treeDataProvider: operationsProvider,
    showCollapseAll: false,
  });
  const cellSyncTimers = new Map<string, NodeJS.Timeout>();

  const scheduleCellSync = (document: vscode.TextDocument): void => {
    if (document.uri.scheme !== "vscode-notebook-cell") return;
    const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
      isManimNotebook(candidate) &&
      candidate.getCells().some((cell) => cell.document.uri.toString() === document.uri.toString()),
    );
    if (!notebook) return;
    const cell = notebook.getCells().find(
      (candidate) => candidate.document.uri.toString() === document.uri.toString(),
    );
    if (!cell || !isManimCell(cell)) {
      return;
    }
    const key = document.uri.toString();
    const existing = cellSyncTimers.get(key);
    if (existing) clearTimeout(existing);
    cellSyncTimers.set(key, setTimeout(() => {
      cellSyncTimers.delete(key);
      void prepareManimNotebook(notebook).then(async () => {
        updateActiveCellContext();
        await kernelRuntime?.syncRuntime(notebook, settings(), sceneCellSettings(notebook));
      });
    }, 120));
  };

  updateActiveCellContext();

  context.subscriptions.push(
    kernelRuntime,
    companionPanel,
    typstMarkdown,
    videoRenderer,
    manimCellStatusBar,
    operationsView,
    vscode.workspace.registerNotebookSerializer(
      NOTEBOOK_TYPE,
      new ManimNotebookSerializer(),
      {
        transientOutputs: false,
      },
    ),
    {
      dispose: () => {
        for (const timer of cellSyncTimers.values()) clearTimeout(timer);
        cellSyncTimers.clear();
      },
    },
    vscode.commands.registerCommand("manimJupyter.newNotebook", newNotebook),
    vscode.commands.registerCommand("manimJupyter.openNotebook", openNotebook),
    vscode.commands.registerCommand("manimJupyter.syncCellSettings", syncActiveNotebookSceneCells),
    vscode.commands.registerCommand("manimJupyter.renderCell", renderCell),
    vscode.commands.registerCommand("manimJupyter.insertCell", insertCell),
    vscode.commands.registerCommand("manimJupyter.insertManimCell", insertManimCell),
    vscode.commands.registerCommand("manimJupyter.changeCodeCellType", changeCodeCellType),
    vscode.commands.registerCommand("manimJupyter.configureCell", configureCell),
    vscode.commands.registerCommand("manimJupyter.exportPptx", exportPptx),
    vscode.commands.registerCommand("manimJupyter.playPresentation", playPresentation),
    vscode.commands.registerCommand("manimJupyter.checkKernel", checkKernel),
    vscode.commands.registerCommand("manimJupyter.insertTypstPreset", insertTypstPreset),
    vscode.commands.registerCommand("manimJupyter.openCompanion", () => companionPanel?.show()),
    vscode.commands.registerCommand("manimJupyter.toggleVideoLoop", async () => {
      const current = settings().videoLoop;
      const target = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration("manimJupyter")
        .update("videoLoop", !current, target);
      operationsProvider.refresh();
      companionPanel?.refresh(true);
      videoRenderer.setVideoLoop(!current);
      await syncActiveNotebookSceneCells();
    }),
    vscode.commands.registerCommand("manimJupyter.openDocs", async () => {
      const query = await vscode.window.showInputBox({ title: "搜索 Manim 文档", placeHolder: "Transform、Axes、TypstMath" });
      if (query !== undefined) {
        await vscode.env.openExternal(vscode.Uri.parse(`https://docs.manim.community/en/stable/search.html?q=${encodeURIComponent(query)}`));
      }
    }),
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settingsView),
    vscode.window.registerWebviewViewProvider(TypstPresetsViewProvider.viewType, typstView),
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      activeNotebookMaintenance.delete(notebook.uri.toString());
      kernelRuntime?.releaseNotebook(notebook);
    }),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      void defaultAddedCodeCellsToManim(event);
    }),
    vscode.window.onDidChangeActiveNotebookEditor(() => {
      updateActiveCellContext();
    }),
    vscode.window.onDidChangeNotebookEditorSelection(() => {
      updateActiveCellContext();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      updateActiveCellContext();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleCellSync(event.document)),
    operationsView.onDidChangeVisibility((event) => {
      if (event.visible) companionPanel?.show();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("manimJupyter") && !settingsView.isWriting) {
        settingsView.refresh();
        operationsProvider.refresh();
        companionPanel?.refresh(true);
        void syncActiveNotebookSceneCells();
      }
    }),
  );

  void kernelRuntime.registerControllers().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Manim kernel controller failed to load: ${detail}`);
  });
}

export function deactivate(): void {}
