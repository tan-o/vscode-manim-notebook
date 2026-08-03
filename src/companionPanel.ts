import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_CELL_SETTINGS,
  ManimCellSettings,
  canonicalManimCellSource,
  isManimCellMetadata,
  isManimNotebookPath,
  previewAtLine,
} from "./core";
import { KernelOutput, LinePreviewResult } from "./kernelRuntime";
import {
  documentationSymbol,
  isOfficialManimDocsUrl,
  OfficialDocsClient,
} from "./officialDocs";
import {
  typstMathContextAtOffset,
  typstMathPythonContextAtOffset,
  typstMathPythonWordAtOffset,
  typstMathSuggestions,
  typstMathWordAtOffset,
} from "./typstMath";

interface HelpEntry {
  title: string;
  detail: string;
  url?: string;
}

interface HelpContext {
  code: string;
  help: HelpEntry;
  mode: "manim" | "typst" | "python" | "idle";
  panelTitle: string;
}

interface PreviewPayload {
  kind: "empty" | "rendering" | "video" | "image" | "error";
  source?: string;
  message: string;
  cellLabel: string;
  statement?: string;
  autoplay: boolean;
  loop: boolean;
  controls: boolean;
}

const HELP: Record<string, HelpEntry> = {
  Scene: {
    title: "Scene",
    detail: "Manim 场景基类。此扩展会在后台把每个 Scene Cell 记录成一页 Manim Slides。",
    url: "https://docs.manim.community/en/stable/reference/manim.scene.scene.Scene.html",
  },
  ThreeDScene: {
    title: "ThreeDScene",
    detail: "三维场景基类，可设置相机方向、光照并加入 3D Mobject。",
    url: "https://docs.manim.community/en/stable/reference/manim.scene.three_d_scene.ThreeDScene.html",
  },
  play: {
    title: "self.play(...)",
    detail: "播放一个或多个 Animation。右上预览只低清渲染光标所在的这一条动画。",
    url: "https://docs.manim.community/en/stable/reference/manim.scene.scene.Scene.html#manim.scene.scene.Scene.play",
  },
  wait: {
    title: "self.wait(...)",
    detail: "保持当前画面指定时间；它也可以作为一条独立动画语句预览。",
    url: "https://docs.manim.community/en/stable/reference/manim.scene.scene.Scene.html#manim.scene.scene.Scene.wait",
  },
  Create: {
    title: "Create",
    detail: "沿 Mobject 的路径逐步绘制对象，适合坐标轴、曲线和几何图形。",
    url: "https://docs.manim.community/en/stable/reference/manim.animation.creation.Create.html",
  },
  Write: {
    title: "Write",
    detail: "以书写方式显示文字或数学公式。请使用 Typst、TypstMath 或 Text。",
    url: "https://docs.manim.community/en/stable/reference/manim.animation.creation.Write.html",
  },
  Transform: {
    title: "Transform",
    detail: "把源 Mobject 平滑变换为目标 Mobject。",
    url: "https://docs.manim.community/en/stable/reference/manim.animation.transform.Transform.html",
  },
  FadeIn: {
    title: "FadeIn",
    detail: "通过透明度变化让对象进入场景，可同时使用 shift 或 scale。",
    url: "https://docs.manim.community/en/stable/reference/manim.animation.fading.FadeIn.html",
  },
  Axes: {
    title: "Axes",
    detail: "二维坐标系。使用 plot、coords_to_point 与 get_axis_labels 构造图像。",
    url: "https://docs.manim.community/en/stable/reference/manim.mobject.graphing.coordinate_systems.Axes.html",
  },
  Typst: {
    title: "Typst · Manim 官方文档",
    detail: "使用 Typst 标记语言渲染文本。",
    url: "https://docs.manim.community/en/latest/reference/manim.mobject.text.typst_mobject.Typst.html",
  },
  TypstMath: {
    title: "TypstMath · Manim 官方文档",
    detail: "使用 Typst 数学语法渲染公式；左侧预设面板包含希腊字母、运算符和结构模板。",
    url: "https://docs.manim.community/en/latest/reference/manim.mobject.text.typst_mobject.TypstMath.html",
  },
};

function text(data: Uint8Array): string {
  return Buffer.from(data).toString("utf8");
}

function concisePythonError(data: Uint8Array): string {
  const raw = text(data);
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; message?: unknown };
    const name = typeof parsed.name === "string" ? parsed.name : "PythonError";
    const message = typeof parsed.message === "string" ? parsed.message : "Python 执行失败";
    return `${name}: ${message}`
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .trim()
      .slice(-1800);
  } catch {
    return raw
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\\u001b\[[0-9;?]*[ -/]*[@-~]/gi, "")
      .trim()
      .slice(-1800);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeMarkdownFragment(value: string): string {
  const withoutLinks = value.replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1");
  return escapeHtml(withoutLinks)
    .replace(/`([^`\r\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\r\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\r?\n/g, "<br>");
}

function safeHoverMarkdown(value: string): string {
  const chunks: string[] = [];
  const pattern = /```([\w+-]*)\r?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) {
      chunks.push(`<div class="native-text">${safeMarkdownFragment(value.slice(cursor, match.index))}</div>`);
    }
    chunks.push(`<pre><code>${escapeHtml(match[2].trim())}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    chunks.push(`<div class="native-text">${safeMarkdownFragment(value.slice(cursor))}</div>`);
  }
  return chunks.join("");
}

function hoverContentsHtml(hovers: readonly vscode.Hover[]): string {
  const sections: string[] = [];
  for (const hover of hovers) {
    for (const content of hover.contents) {
      if (typeof content === "string") {
        sections.push(safeHoverMarkdown(content));
      } else if ("language" in content) {
        sections.push(`<pre><code>${escapeHtml(content.value)}</code></pre>`);
      } else {
        sections.push(safeHoverMarkdown(content.value));
      }
    }
  }
  return sections.filter(Boolean).join('<div class="native-separator"></div>');
}

function cellLabel(cell: vscode.NotebookCell | undefined): string {
  return cell ? `Cell ${cell.index + 1}` : "未选择 Cell";
}

function isManimNotebook(notebook: vscode.NotebookDocument | undefined): boolean {
  return Boolean(notebook && isManimNotebookPath(notebook.uri.path));
}

export class CompanionPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private lastNotebookEditor: vscode.NotebookEditor | undefined;
  private previewTimer: NodeJS.Timeout | undefined;
  private helpTimer: NodeJS.Timeout | undefined;
  private previewGeneration = 0;
  private previewRunning = false;
  private previewQueued = false;
  private helpGeneration = 0;
  private readonly officialDocs: OfficialDocsClient;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    docsCacheUri: vscode.Uri,
    private readonly previewLine: (
      cell: vscode.NotebookCell,
      line: number,
    ) => Promise<LinePreviewResult | undefined>,
    private readonly cellSettings: (
      cell: vscode.NotebookCell,
    ) => ManimCellSettings = () => DEFAULT_CELL_SETTINGS,
  ) {
    this.officialDocs = new OfficialDocsClient(docsCacheUri.fsPath);
    this.lastNotebookEditor = vscode.window.activeNotebookEditor;
    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (isManimNotebook(editor?.notebook)) {
          this.lastNotebookEditor = editor;
        }
        this.refresh();
      }),
      vscode.window.onDidChangeNotebookEditorSelection((event) => {
        if (isManimNotebook(event.notebookEditor.notebook)) {
          this.lastNotebookEditor = event.notebookEditor;
          this.refresh();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.uri.toString() === this.currentCell()?.document.uri.toString()) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.currentCell()?.document.uri.toString() === event.document.uri.toString()) {
          this.refresh();
        }
      }),
    );
  }

  dispose(): void {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
    }
    if (this.helpTimer) {
      clearTimeout(this.helpTimer);
    }
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  show(): void {
    if (isManimNotebook(vscode.window.activeNotebookEditor?.notebook)) {
      this.lastNotebookEditor = vscode.window.activeNotebookEditor;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.refresh();
      return;
    }
    const notebook = this.currentNotebook();
    this.panel = vscode.window.createWebviewPanel(
      "manimJupyter.companion",
      "Manim 对象与动画预览",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.localResourceRoots(notebook),
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "assets", "manim-jupyter.svg");
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const data = message as { type?: string; url?: string };
      if (data.type === "ready" || data.type === "refresh") {
        this.refresh(true);
      } else if (data.type === "retryHelp") {
        this.postHelp(this.currentCell());
      } else if (data.type === "navigateDocs" && data.url && isOfficialManimDocsUrl(data.url)) {
        void this.postExplicitHelp(data.url);
      } else if (data.type === "open" && data.url?.startsWith("https://")) {
        await vscode.env.openExternal(vscode.Uri.parse(data.url));
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  refresh(immediate = false): void {
    if (!this.panel) {
      return;
    }
    const cell = this.currentCell();
    this.updateLocalResourceRoots(cell?.notebook);
    if (this.helpTimer) clearTimeout(this.helpTimer);
    this.helpTimer = setTimeout(
      () => {
        this.helpTimer = undefined;
        this.postHelp(cell);
      },
      immediate ? 0 : 180,
    );
    this.previewGeneration += 1;
    const generation = this.previewGeneration;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
    }
    this.previewTimer = setTimeout(
      () => void this.refreshPreview(generation),
      immediate ? 0 : 650,
    );
  }

  private async refreshPreview(generation: number): Promise<void> {
    if (this.previewRunning) {
      this.previewQueued = true;
      return;
    }
    this.previewRunning = true;
    const cell = this.currentCell();
    const line = this.currentLine(cell);
    const options = cell ? this.cellSettings(cell) : DEFAULT_CELL_SETTINGS;
    try {
      if (
        !cell ||
        line === undefined ||
        cell.kind !== vscode.NotebookCellKind.Code ||
        !isManimCellMetadata(cell.metadata)
      ) {
        if (generation === this.previewGeneration) {
          this.postPreview(this.empty(cell, "把光标放到对象定义、位置调整或动画语句上。"));
        }
        return;
      }
      if (!options.linePreview) {
        if (generation === this.previewGeneration) {
          this.postPreview(this.empty(cell, "当前 Cell 已关闭语句预览，可从 Cell 右上角设置按钮重新开启。"));
        }
        return;
      }
      if (generation === this.previewGeneration) {
        this.postPreview({
          kind: "rendering",
          message: "正在低清渲染光标所在的对象或动画……",
          cellLabel: cellLabel(cell),
          autoplay: true,
          loop: options.loop,
          controls: options.controls,
        });
      }
      const result = await this.previewLine(cell, line);
      if (generation !== this.previewGeneration) {
        return;
      }
      if (!result) {
        this.postPreview(this.empty(cell, "当前行没有可预览的 Manim 对象、位置调整或动画。"));
        return;
      }
      this.postPreview(this.previewFromOutputs(cell, result.outputs, result, options));
    } catch (error) {
      if (generation !== this.previewGeneration) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.postPreview({
        kind: "error",
        message: message.slice(-1800),
        cellLabel: cellLabel(cell),
        autoplay: true,
        loop: options.loop,
        controls: options.controls,
      });
    } finally {
      this.previewRunning = false;
      if (this.previewQueued) {
        this.previewQueued = false;
        this.refresh(true);
      }
    }
  }

  private empty(cell: vscode.NotebookCell | undefined, message: string): PreviewPayload {
    const options = cell ? this.cellSettings(cell) : DEFAULT_CELL_SETTINGS;
    return {
      kind: "empty",
      message,
      cellLabel: cellLabel(cell),
      autoplay: true,
      loop: options.loop,
      controls: options.controls,
    };
  }

  private previewFromOutputs(
    cell: vscode.NotebookCell,
    outputs: KernelOutput[],
    result: LinePreviewResult,
    options: ManimCellSettings,
  ): PreviewPayload {
    let progress = "";
    const label = result.kind === "object"
      ? `对象 ${result.objectName ?? "预览"}`
      : `第 ${(result.animationIndex ?? 0) + 1} 条动画`;
    for (const output of outputs) {
      for (const item of output.items) {
        if (item.mime === "application/vnd.manim.video+json") {
          try {
            const descriptor = JSON.parse(text(item.data)) as { path?: unknown };
            const source = typeof descriptor.path === "string"
              ? this.resolveMediaSource(descriptor.path, cell)
              : undefined;
            if (source) {
              return {
                kind: "video",
                source,
                message: label,
                statement: result.statement,
                cellLabel: cellLabel(cell),
                autoplay: true,
                loop: options.loop,
                controls: options.controls,
              };
            }
          } catch {
            // Ignore malformed renderer payloads and continue to other mimes.
          }
        }
        if (item.mime.startsWith("image/") && item.mime !== "image/svg+xml") {
          return {
            kind: "image",
            source: `data:${item.mime};base64,${Buffer.from(item.data).toString("base64")}`,
            message: label,
            statement: result.statement,
            cellLabel: cellLabel(cell),
            autoplay: true,
            loop: options.loop,
            controls: options.controls,
          };
        }
        if (item.mime === "image/svg+xml") {
          return {
            kind: "image",
            source: `data:image/svg+xml;base64,${Buffer.from(item.data).toString("base64")}`,
            message: label,
            statement: result.statement,
            cellLabel: cellLabel(cell),
            autoplay: true,
            loop: options.loop,
            controls: options.controls,
          };
        }
        if (item.mime === "text/html") {
          const media = this.mediaFromHtml(text(item.data), cell);
          if (media) {
            return {
              ...media,
              message: label,
              statement: result.statement,
              cellLabel: cellLabel(cell),
              autoplay: true,
              loop: options.loop,
              controls: options.controls,
            };
          }
        }
        if (item.mime === "application/vnd.code.notebook.error") {
          return {
            kind: "error",
            message: concisePythonError(item.data),
            cellLabel: cellLabel(cell),
            autoplay: true,
            loop: options.loop,
            controls: options.controls,
          };
        }
        if (item.mime.includes("stdout") || item.mime.includes("stderr") || item.mime === "text/plain") {
          progress = text(item.data).trim().slice(-1200) || progress;
        }
      }
    }
    return {
      kind: "empty",
      message: progress || "语句渲染完成，但没有找到视频输出。",
      statement: result.statement,
      cellLabel: cellLabel(cell),
      autoplay: true,
      loop: options.loop,
      controls: options.controls,
    };
  }

  private mediaFromHtml(
    html: string,
    cell: vscode.NotebookCell,
  ): Pick<PreviewPayload, "kind" | "source"> | undefined {
    const match = html.match(/<(video|img|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!match) {
      return undefined;
    }
    const source = this.resolveMediaSource(match[2], cell);
    return source
      ? { kind: match[1].toLowerCase() === "img" ? "image" : "video", source }
      : undefined;
  }

  private resolveMediaSource(source: string, cell: vscode.NotebookCell): string | undefined {
    if (source.startsWith("data:")) {
      return source;
    }
    if (!this.panel) {
      return undefined;
    }
    this.updateLocalResourceRoots(cell.notebook);
    let decoded = source.split(/[?#]/, 1)[0];
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep a non-URL encoded path unchanged.
    }
    const candidates: string[] = [];
    if (decoded.startsWith("file:")) {
      candidates.push(vscode.Uri.parse(decoded).fsPath);
    } else if (path.isAbsolute(decoded)) {
      candidates.push(decoded);
    } else {
      if (cell.notebook.uri.scheme === "file") {
        candidates.push(path.resolve(path.dirname(cell.notebook.uri.fsPath), decoded));
      }
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(path.resolve(folder.uri.fsPath, decoded));
      }
    }
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    return existing
      ? this.panel.webview.asWebviewUri(vscode.Uri.file(existing)).toString()
      : undefined;
  }

  private localResourceRoots(notebook?: vscode.NotebookDocument): vscode.Uri[] {
    const roots = [this.extensionUri, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)];
    if (notebook?.uri.scheme === "file") {
      roots.push(vscode.Uri.file(path.dirname(notebook.uri.fsPath)));
    }
    const seen = new Set<string>();
    return roots.filter((root) => {
      const key = root.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private updateLocalResourceRoots(notebook?: vscode.NotebookDocument): void {
    if (!this.panel) return;
    this.panel.webview.options = {
      ...this.panel.webview.options,
      localResourceRoots: this.localResourceRoots(notebook),
    };
  }

  private currentNotebook(): vscode.NotebookDocument | undefined {
    return this.lastNotebookEditor?.notebook;
  }

  private currentCell(): vscode.NotebookCell | undefined {
    const active = vscode.window.activeNotebookEditor;
    const editor = isManimNotebook(active?.notebook) ? active : this.lastNotebookEditor;
    if (!editor || !isManimNotebook(editor.notebook)) {
      return undefined;
    }
    this.lastNotebookEditor = editor;
    const index = Math.min(editor.selection.start, editor.notebook.cellCount - 1);
    return index >= 0 ? editor.notebook.cellAt(index) : undefined;
  }

  private currentLine(cell: vscode.NotebookCell | undefined): number | undefined {
    if (!cell) {
      return undefined;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === cell.document.uri.toString(),
    );
    return editor?.selection.active.line;
  }

  private currentPosition(cell: vscode.NotebookCell | undefined): vscode.Position | undefined {
    if (!cell) return undefined;
    return vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === cell.document.uri.toString(),
    )?.selection.active;
  }

  private postPreview(preview: PreviewPayload): void {
    void this.panel?.webview.postMessage({ type: "preview", preview });
  }

  private postHelp(cell: vscode.NotebookCell | undefined): void {
    const context = this.helpContext(cell);
    const generation = ++this.helpGeneration;
    if (context.mode === "typst") {
      void this.panel?.webview.postMessage({
        type: "help",
        ...context,
        document: { status: "ready", html: this.typstHelpHtml(cell) },
      });
      return;
    }
    if (context.mode === "python") {
      void this.panel?.webview.postMessage({
        type: "help",
        ...context,
        document: { status: "loading", loadingText: "正在读取 Python/Pylance 原生提示……" },
      });
      const position = this.currentPosition(cell) ?? new vscode.Position(0, 0);
      void vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        cell!.document.uri,
        position,
      ).then((hovers) => {
        if (generation !== this.helpGeneration) return;
        const html = hovers?.length
          ? hoverContentsHtml(hovers)
          : `<p>当前符号没有 Python/Pylance 原生文档。把光标放到函数、类或变量名称上再试。</p>`;
        void this.panel?.webview.postMessage({
          type: "help",
          ...context,
          document: { status: "ready", html },
        });
      }, (error: unknown) => {
        if (generation !== this.helpGeneration) return;
        const message = error instanceof Error ? error.message : String(error);
        void this.panel?.webview.postMessage({
          type: "help",
          ...context,
          document: {
            status: "ready",
            html: `<p>Python/Pylance 暂时没有返回提示。</p><pre><code>${escapeHtml(message)}</code></pre>`,
          },
        });
      });
      return;
    }
    if (context.mode === "idle" || !context.help.url) {
      void this.panel?.webview.postMessage({
        type: "help",
        ...context,
        document: {
          status: "ready",
          html: `<h3>${escapeHtml(context.help.title)}</h3><p>${escapeHtml(context.help.detail)}</p>`,
        },
      });
      return;
    }
    void this.panel?.webview.postMessage({
      type: "help",
      ...context,
      document: { status: "loading", sourceUrl: context.help.url },
    });
    void this.officialDocs.load(context.help.url, this.helpSymbol(context.help)).then(
      (document) => {
        if (generation !== this.helpGeneration) return;
        void this.panel?.webview.postMessage({
          type: "help",
          ...context,
          document: { status: "ready", ...document },
        });
      },
      (error: unknown) => {
        if (generation !== this.helpGeneration) return;
        const message = error instanceof Error ? error.message : String(error);
        void this.panel?.webview.postMessage({
          type: "help",
          ...context,
          document: { status: "error", sourceUrl: context.help.url, message },
        });
      },
    );
  }

  private helpSymbol(help: HelpEntry): string | undefined {
    const value = help.title.split(/[·(]/, 1)[0].replace(/^self\./, "").trim();
    return /^[A-Za-z_]\w*$/.test(value) ? value : undefined;
  }

  private typstHelpHtml(cell: vscode.NotebookCell | undefined): string {
    if (!cell) return "<p>未选择 Typst 数学公式。</p>";
    const position = this.currentPosition(cell);
    const offset = position ? cell.document.offsetAt(position) : 0;
    const source = cell.document.getText();
    const inManimCell = cell.kind === vscode.NotebookCellKind.Code &&
      isManimCellMetadata(cell.metadata);
    const context = inManimCell
      ? typstMathPythonContextAtOffset(source, offset)
      : typstMathContextAtOffset(source, offset);
    if (!context) {
      return inManimCell
        ? "<p>把光标放进 <code>TypstMath(r\"...\")</code> 的字符串中查看符号说明与候选。</p>"
        : "<p>把光标放进 Markdown 的 <code>$...$</code> 或 <code>$$...$$</code> 中。</p>";
    }
    const word = inManimCell
      ? typstMathPythonWordAtOffset(source, offset)
      : typstMathWordAtOffset(source, offset);
    const suggestions = typstMathSuggestions(word?.prefix ?? "", 10);
    const expression = source.slice(context.contentStart, context.contentEnd).trim();
    const current = suggestions[0];
    const heading = current
      ? `<h2>${escapeHtml(current.glyph)} ${escapeHtml(current.label)}</h2><p>${escapeHtml(current.detail)}</p><pre><code>${escapeHtml(current.insertText.replace(/\$\{\d+:([^}]+)\}/g, "$1"))}</code></pre>`
      : `<h2>Typst 数学模式</h2><p>当前内容是 Typst 数学表达式，不会查询 Manim 文档。</p>`;
    const candidates = suggestions.length
      ? `<h3>${word?.prefix ? `“${escapeHtml(word.prefix)}” 的候选` : "Typst 数学符号"}</h3><table><thead><tr><th>输入</th><th>符号</th><th>说明</th></tr></thead><tbody>${suggestions.map((item) => `<tr><td><code>${escapeHtml(item.label)}</code></td><td>${escapeHtml(item.glyph)}</td><td>${escapeHtml(item.detail)}</td></tr>`).join("")}</tbody></table>`
      : `<p>没有与当前输入匹配的内置 Typst 数学符号。</p>`;
    return `${heading}<h3>当前公式</h3><pre><code>${escapeHtml(expression)}</code></pre>${candidates}`;
  }

  private async postExplicitHelp(url: string): Promise<void> {
    const generation = ++this.helpGeneration;
    const context = {
      code: "Manim Community 官方文档",
      help: { title: "正在读取官方文档", detail: "", url },
      mode: "manim" as const,
      panelTitle: "Manim 官方文档",
    };
    void this.panel?.webview.postMessage({
      type: "help",
      ...context,
      document: { status: "loading", sourceUrl: url },
    });
    try {
      const document = await this.officialDocs.load(url);
      if (generation !== this.helpGeneration) return;
      void this.panel?.webview.postMessage({
        type: "help",
        code: context.code,
        help: { ...context.help, title: "Manim Community 官方文档" },
        document: { status: "ready", ...document },
      });
    } catch (error) {
      if (generation !== this.helpGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      void this.panel?.webview.postMessage({
        type: "help",
        ...context,
        document: { status: "error", sourceUrl: url, message },
      });
    }
  }

  private helpContext(cell: vscode.NotebookCell | undefined): HelpContext {
    if (!cell) {
      return {
        code: "未选择代码",
        mode: "idle",
        panelTitle: "上下文帮助",
        help: {
          title: "Waiting for a Manim Notebook",
          detail: "打开 Notebook 后，将光标放到 Manim 类、方法或 TypstMath 上。",
        },
      };
    }
    const position = this.currentPosition(cell);
    const fullSource = cell.document.getText();
    const offset = position ? cell.document.offsetAt(position) : 0;
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const typst = typstMathContextAtOffset(fullSource, offset);
      if (typst) {
        const word = typstMathWordAtOffset(fullSource, offset);
        const first = typstMathSuggestions(word?.prefix ?? "", 1)[0];
        return {
          code: fullSource.slice(typst.contentStart, typst.contentEnd).trim(),
          mode: "typst",
          panelTitle: "Typst 数学帮助",
          help: {
            title: first?.label ?? "Typst 数学模式",
            detail: first?.detail ?? "显示当前 Typst 公式及离线符号候选。",
          },
        };
      }
      return {
        code: "Markdown",
        mode: "idle",
        panelTitle: "Typst 数学帮助",
        help: {
          title: "等待 Typst 数学公式",
          detail: "把光标放进 Markdown 的 $...$ 或 $$...$$ 中查看符号说明与候选。",
        },
      };
    }
    const lineNumber = Math.min(this.currentLine(cell) ?? 0, cell.document.lineCount - 1);
    const line = cell.document.lineAt(Math.min(lineNumber, cell.document.lineCount - 1)).text.trim();
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === cell.document.uri.toString(),
    );
    const cursorWord = editor
      ? cell.document.getText(cell.document.getWordRangeAtPosition(editor.selection.active))
      : "";
    if (isManimCellMetadata(cell.metadata)) {
      // Inside a TypstMath("...") string the panel shows offline Typst
      // completions instead of a Manim API page.
      const typst = typstMathPythonContextAtOffset(fullSource, offset);
      if (typst) {
        const word = typstMathPythonWordAtOffset(fullSource, offset);
        const first = typstMathSuggestions(word?.prefix ?? "", 1)[0];
        return {
          code: fullSource.slice(typst.contentStart, typst.contentEnd).trim(),
          mode: "typst",
          panelTitle: "Typst 数学帮助",
          help: {
            title: first?.label ?? "Typst 数学模式",
            detail: first?.detail ?? "显示当前 Typst 公式及离线符号候选。",
          },
        };
      }
      // Manim cells always resolve to the official Manim documentation.
      const source = canonicalManimCellSource(cell.document.getText());
      const statement = previewAtLine(source, lineNumber)?.text ?? line;
      const searchable = `${cursorWord}\n${line}\n${statement}`;
      const token = Object.keys(HELP).find((name) =>
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(searchable),
      );
      if (token) {
        return {
          code: statement || token,
          help: HELP[token],
          mode: "manim",
          panelTitle: "Manim 官方文档",
        };
      }
      const helpWord = documentationSymbol(cursorWord, statement) ?? "";
      if (/^[A-Za-z_]\w*$/.test(helpWord)) {
        return {
          code: statement || helpWord,
          mode: "manim",
          panelTitle: "Manim 官方文档",
          help: {
            title: helpWord,
            detail: "",
            url: `https://docs.manim.community/en/stable/search.html?q=${encodeURIComponent(helpWord)}`,
          },
        };
      }
      return {
        code: line || "空白行",
        mode: "manim",
        panelTitle: "Manim 官方文档",
        help: {
          title: "Manim Community 官方文档",
          detail: "把光标移动到 Scene、self.play、Create、Transform、TypstMath 或其他 Manim 名称上。",
          url: "https://docs.manim.community/en/stable/reference.html",
        },
      };
    }
    // Plain Python cells use the native Python language server (Pylance).
    return {
      code: position
        ? cell.document.getText(cell.document.getWordRangeAtPosition(position))
        : "Python",
      mode: "python",
      panelTitle: "Python 原生帮助",
      help: {
        title: "Python / Pylance",
        detail: "内容直接来自 VS Code 的 Python 语言服务。",
      },
    };
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource} data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; } * { box-sizing: border-box; }
    html,body { width:100%;height:100%;margin:0;overflow:hidden; }
    body { color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family); }
    .layout { height:100vh;display:grid;grid-template-rows:minmax(280px,58%) minmax(210px,42%); }
    section { min-height:0;display:grid;grid-template-rows:36px 1fr; }
    section+section { border-top:1px solid var(--vscode-panel-border); }
    .section-title { display:flex;align-items:center;gap:7px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase; }
    .chevron { width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px); }
    .preview-body { position:relative;min-height:0;display:grid;place-items:center;padding:38px 16px 16px;overflow:hidden; }
    .preview-meta { position:absolute;left:12px;top:9px;color:var(--vscode-descriptionForeground);font-size:12px; }
    .statement { position:absolute;right:12px;top:9px;left:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font:12px var(--vscode-editor-font-family); }
    .media { display:none;max-width:100%;max-height:100%;border:1px solid var(--vscode-panel-border);background:#000;box-shadow:0 4px 18px rgba(0,0,0,.22); }
    video.media { width:100%; }
    .empty { max-width:440px;text-align:center;color:var(--vscode-descriptionForeground); }
    .empty strong { display:block;margin-bottom:8px;color:var(--vscode-foreground);font-size:15px; }
    .message { max-height:110px;overflow:auto;margin:0 0 14px;white-space:pre-wrap;font:12px/1.45 var(--vscode-editor-font-family); }
    .spinner { display:none;width:22px;height:22px;margin:0 auto 12px;border:2px solid var(--vscode-progressBar-background);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    button { min-height:28px;padding:4px 12px;border:1px solid transparent;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);font:13px var(--vscode-font-family);cursor:pointer; }
    button:hover { background:var(--vscode-button-secondaryHoverBackground); }
    section.docs-section { grid-template-rows:36px 1fr; }
    .help-body { min-height:0;overflow:auto;padding:14px 16px 24px; }
    .docs-status { display:flex;align-items:center;gap:8px;margin:14px 0;color:var(--vscode-descriptionForeground);font-size:12px; }
    .docs-status .spinner { width:16px;height:16px;margin:0;flex:0 0 auto; }
    .docs-content { font:13px/1.55 var(--vscode-font-family);overflow-wrap:anywhere; }
    .docs-content h1 { margin:18px 0 9px;font-size:20px; }
    .docs-content h2 { margin:18px 0 8px;font-size:17px; }
    .docs-content h3,.docs-content h4 { margin:16px 0 7px;font-size:14px; }
    .docs-content p { margin:7px 0; }
    .docs-content a { color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer; }
    .docs-content a:hover { color:var(--vscode-textLink-activeForeground);text-decoration:underline; }
    .docs-content pre { max-width:100%;padding:10px;overflow:auto;border:1px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background);font:12px/1.5 var(--vscode-editor-font-family); }
    .docs-content code,.docs-content kbd,.docs-content samp { font-family:var(--vscode-editor-font-family); }
    .docs-content :not(pre)>code { padding:1px 4px;border-radius:3px;background:var(--vscode-textCodeBlock-background); }
    .docs-content table { width:100%;border-collapse:collapse;margin:10px 0; }
    .docs-content th,.docs-content td { padding:5px 7px;border:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top; }
    .docs-content dl { margin:9px 0; }
    .docs-content dt { margin-top:10px;font-weight:600; }
    .docs-content dd { margin:4px 0 10px 14px; }
    .docs-error { padding:10px;border-left:3px solid var(--vscode-errorForeground);background:var(--vscode-inputValidation-errorBackground);white-space:pre-wrap; }
    .docs-error strong { display:block;margin-bottom:6px; }
    .docs-error-detail { margin-top:7px;color:var(--vscode-descriptionForeground);font:12px/1.45 var(--vscode-editor-font-family); }
    .docs-actions { display:flex;flex-wrap:wrap;gap:7px;margin-top:10px; }
    @media (prefers-reduced-motion:reduce) { .spinner { animation:none; } }
  </style>
</head>
<body>
  <main class="layout">
    <section><div class="section-title"><span class="chevron"></span>当前对象与动画预览</div>
      <div class="preview-body"><div class="preview-meta" id="cellLabel">未选择 Cell</div><div class="statement" id="statement"></div>
        <video id="video" class="media" playsinline muted></video><img id="image" class="media" alt="当前对象或动画预览">
        <div class="empty" id="empty"><div class="spinner" id="spinner"></div><strong id="previewTitle">等待对象或动画</strong><pre class="message" id="previewMessage">把光标放到对象定义、位置调整或动画语句上。</pre><button id="refresh">重新预览</button></div>
      </div>
    </section>
    <section class="docs-section">
      <div class="section-title"><span class="chevron"></span><span id="helpPanelTitle">上下文帮助</span></div>
      <div class="help-body"><div class="docs-status" id="docsStatus"><span class="spinner" id="docsSpinner"></span><span id="docsStatusText">Loading docs.manim.community…</span></div><div class="docs-content" id="docsContent"></div></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(),video=document.getElementById('video'),image=document.getElementById('image'),empty=document.getElementById('empty'),spinner=document.getElementById('spinner'),helpPanelTitle=document.getElementById('helpPanelTitle'),docsStatus=document.getElementById('docsStatus'),docsSpinner=document.getElementById('docsSpinner'),docsStatusText=document.getElementById('docsStatusText'),docsContent=document.getElementById('docsContent');
    function showPreview(p){
      const title=document.getElementById('previewTitle'),message=document.getElementById('previewMessage');
      document.getElementById('cellLabel').textContent=p.cellLabel;
      document.getElementById('statement').textContent=p.statement||'';
      video.pause();video.oncanplay=null;video.onloadedmetadata=null;video.onerror=null;video.removeAttribute('src');
      image.removeAttribute('src');video.style.display='none';image.style.display='none';empty.style.display='block';
      spinner.style.display=p.kind==='rendering'?'block':'none';
      title.textContent=p.kind==='error'?'预览失败':p.kind==='rendering'?'正在渲染':p.kind==='video'||p.kind==='image'?'对象/动画预览':'等待对象或动画';
      message.textContent=p.message;video.loop=!!p.loop;video.controls=!!p.controls;video.autoplay=!!p.autoplay;video.muted=!!p.autoplay;video.defaultMuted=!!p.autoplay;
      if(p.kind==='video'&&p.source){
        spinner.style.display='block';title.textContent='正在读取视频';video.src=p.source;
        video.onloadedmetadata=()=>{
          if(!Number.isFinite(video.duration)||video.duration<=0){spinner.style.display='none';title.textContent='预览失败';message.textContent='Manim 视频没有有效时长。';return;}
          spinner.style.display='none';empty.style.display='none';video.style.display='block';
          if(p.autoplay)video.play().catch(()=>{empty.style.display='block';title.textContent='点击视频播放';message.textContent=p.message;});
        };
        video.onerror=()=>{spinner.style.display='none';title.textContent='预览失败';message.textContent='VS Code 无法读取 Manim 视频，请重新渲染当前语句。';};
        video.load();
      }else if(p.kind==='image'&&p.source){empty.style.display='none';image.src=p.source;image.style.display='block';}
    }
    function docsAction(label,handler){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',handler);return button;}
    function showHelp(d){
      const doc=d.document||{};docsContent.replaceChildren();
      helpPanelTitle.textContent=d.panelTitle||'上下文帮助';
      if(doc.status==='loading'){docsStatus.style.display='flex';docsSpinner.style.display='block';docsStatusText.textContent=doc.loadingText||'正在读取 docs.manim.community…';return;}
      docsSpinner.style.display='none';
      if(doc.status==='error'){
        docsStatus.style.display='none';
        const error=document.createElement('div');error.className='docs-error';
        const title=document.createElement('strong');title.textContent='官方文档暂时不可用';error.appendChild(title);
        if(d.help&&d.help.detail){const fallback=document.createElement('div');fallback.textContent=d.help.detail;error.appendChild(fallback);}
        const detail=document.createElement('div');detail.className='docs-error-detail';detail.textContent=doc.message||'无法读取 Manim Community 官方文档。';error.appendChild(detail);
        const actions=document.createElement('div');actions.className='docs-actions';
        actions.appendChild(docsAction('重试',()=>vscode.postMessage({type:'retryHelp'})));
        if(doc.sourceUrl)actions.appendChild(docsAction('在浏览器中打开',()=>vscode.postMessage({type:'open',url:doc.sourceUrl})));
        error.appendChild(actions);docsContent.appendChild(error);return;
      }
      docsStatus.style.display='none';docsContent.innerHTML=doc.html||'';
    }
    window.addEventListener('message',e=>{const d=e.data;if(d.type==='preview')showPreview(d.preview);if(d.type==='help')showHelp(d);});
    docsContent.addEventListener('click',e=>{const link=e.target.closest&&e.target.closest('a[data-doc-url]');if(!link)return;e.preventDefault();const url=link.dataset.docUrl;if(url)vscode.postMessage({type:'navigateDocs',url});});
    document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));vscode.postMessage({type:'ready'});
  </script>
</body></html>`;
  }
}
