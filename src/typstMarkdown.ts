import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { isManimNotebookPath, mathSpanAtOffset } from "./core";
import {
  normalizeTypstMathExpression,
  typstMathSuggestions,
  typstMathWordAtOffset,
} from "./typstMath";
import { MANIM_NOTEBOOK_TYPE } from "./notebookSerializer";

export const TYPST_MARKDOWN_RENDERER_ID = "manimJupyter.typst-markdown-renderer";

function escapeTypstString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface TypstMathmlResult {
  mathml?: string;
  css?: string;
  error?: string;
}

interface TypstSvgResult {
  svg?: string;
  error?: string;
}

type TypstExecutableProvider = (
  notebook?: vscode.NotebookDocument,
) => Promise<string | undefined> | string | undefined;

interface TypstProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

const TYPST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TYPST_TIMEOUT_MS = 15_000;

function runTypst(
  executable: string,
  source: string,
  format: "html" | "svg" = "html",
): Promise<TypstProcessResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "compile",
      ...(format === "html" ? ["--features", "html"] : []),
      "--format",
      format,
      "-",
      "-",
    ];
    const child = spawn(
      executable,
      args,
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TYPST_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > TYPST_MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > TYPST_MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut, overflow });
    });
    child.stdin.on("error", () => {
      // The child may exit before stdin closes; the close/error handlers report it.
    });
    child.stdin.end(source, "utf8");
  });
}

export class TypstMarkdownService implements vscode.Disposable {
  private readonly cache = new Map<string, string>();
  private cursorHoverTimer: NodeJS.Timeout | undefined;
  private readonly messaging = vscode.notebooks.createRendererMessaging(
    TYPST_MARKDOWN_RENDERER_ID,
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly typstExecutable?: TypstExecutableProvider,
  ) {
    const markdownCells: vscode.DocumentSelector = [
      {
        language: "markdown",
        notebookType: MANIM_NOTEBOOK_TYPE,
      },
    ];
    this.disposables.push(
      this.messaging.onDidReceiveMessage(async (event) => {
        const message = event.message as {
          type?: string;
          id?: string;
          expression?: string;
          display?: boolean;
        };
        if (
          message.type !== "renderTypst" ||
          !message.id ||
          typeof message.expression !== "string" ||
          event.editor.notebook.notebookType !== MANIM_NOTEBOOK_TYPE ||
          !isManimNotebookPath(event.editor.notebook.uri.path)
        ) {
          return;
        }
        const result = await this.compile(
          message.expression,
          Boolean(message.display),
          undefined,
          event.editor.notebook,
        );
        void this.reply(
          {
            type: "typstRendered",
            id: message.id,
            mathml: result.mathml,
            css: result.css,
            error: result.error,
          },
          event.editor,
        );
      }),
      vscode.languages.registerHoverProvider(
        markdownCells,
        {
          provideHover: (document, position) => this.hover(document, position),
        },
      ),
      vscode.languages.registerCompletionItemProvider(
        markdownCells,
        {
          provideCompletionItems: (document, position) =>
            this.completions(document, position),
        },
        ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.".split(""),
      ),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.scheduleCursorHover(event.textEditor);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.toString() === event.document.uri.toString()) {
          this.scheduleCursorHover(editor);
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.cache.clear();
      }),
    );
  }

  private notebookForDocument(document: vscode.TextDocument): vscode.NotebookDocument | undefined {
    return vscode.workspace.notebookDocuments.find((candidate) =>
      candidate.notebookType === MANIM_NOTEBOOK_TYPE &&
      isManimNotebookPath(candidate.uri.path) &&
      candidate.getCells().some((cell) => cell.document.uri.toString() === document.uri.toString()),
    );
  }

  private scheduleCursorHover(editor: vscode.TextEditor): void {
    if (this.cursorHoverTimer) clearTimeout(this.cursorHoverTimer);
    this.cursorHoverTimer = undefined;
    const document = editor.document;
    if (document.languageId !== "markdown" || !this.notebookForDocument(document)) return;
    const offset = document.offsetAt(editor.selection.active);
    if (!mathSpanAtOffset(document.getText(), offset)) return;
    const uri = document.uri.toString();
    const expectedOffset = offset;
    this.cursorHoverTimer = setTimeout(() => {
      this.cursorHoverTimer = undefined;
      const active = vscode.window.activeTextEditor;
      if (
        active?.document.uri.toString() !== uri ||
        active.document.offsetAt(active.selection.active) !== expectedOffset
      ) {
        return;
      }
      void vscode.commands.executeCommand("editor.action.showHover");
    }, 220);
  }

  private async reply(
    message: unknown,
    editor: vscode.NotebookEditor,
  ): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        // A reply to a renderer-originated request has a reliable editor
        // target. Prefer it so the SVG returns to the exact Markdown webview.
        if (await this.messaging.postMessage(message, editor)) {
          return;
        }
      } catch {
        // A restored Notebook editor can briefly have a stale webview handle.
      }
      try {
        // Request IDs are globally unique, so broadcast is a safe fallback;
        // only the renderer that owns the pending ID consumes the response.
        if (await this.messaging.postMessage(message)) {
          return;
        }
      } catch {
        // The renderer-side request retry will ask again if this reply loses
        // the race with a webview reload.
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  dispose(): void {
    if (this.cursorHoverTimer) clearTimeout(this.cursorHoverTimer);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async compile(
    expression: string,
    display: boolean,
    foregroundOverride?: string,
    notebook?: vscode.NotebookDocument,
  ): Promise<TypstMathmlResult> {
    const foreground = foregroundOverride ?? (
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
        ? "#1F2328"
        : "#E6EDF3"
    );
    const normalizedExpression = normalizeTypstMathExpression(expression);
    const key = createHash("sha1")
      .update(`${foreground}\0${display}\0${normalizedExpression}`, "utf8")
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      return JSON.parse(cached) as TypstMathmlResult;
    }
    // Typst 0.13+ exports mathematics as native MathML. Chromium renders
    // MathML directly in the Markdown flow: no SVG images, no third-party
    // math renderer, and the formula follows the current theme without a
    // second compile.
    const source = `#set text(size: 16pt, fill: rgb("${escapeTypstString(foreground)}"))
${display ? `$ ${normalizedExpression} $` : `$${normalizedExpression}$`}
`;
    const executable = (await this.typstExecutable?.(notebook)) || "typst";
    let result: TypstProcessResult;
    try {
      result = await runTypst(executable, source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Typst 启动失败：${message}` };
    }
    if (result.timedOut) {
      return { error: `Typst 编译超过 ${TYPST_TIMEOUT_MS / 1000} 秒，已停止。` };
    }
    if (result.overflow) {
      return { error: "Typst 输出超过 4 MiB，已停止读取。" };
    }
    if (result.status !== 0 || !result.stdout.trim()) {
      return {
        error: (result.stderr || "Typst 没有生成 MathML。")
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim()
          .slice(-1200)
          + "（Markdown 数学公式使用 Typst 原生 MathML 输出，需要 typst >= 0.13。）",
      };
    }
    const html = result.stdout;
    const math = html.match(/<math\b[\s\S]*?<\/math>/g);
    const style = html.match(/<style>([\s\S]*?)<\/style>/);
    const mathml = math?.join("\n").trim();
    if (!mathml) {
      return { error: "Typst 没有生成 MathML 公式。" };
    }
    const css = style?.[1]?.trim() || "";
    const compiled: TypstMathmlResult = { mathml, css };
    this.cache.set(key, JSON.stringify(compiled));
    return compiled;
  }

  private async hover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const notebook = this.notebookForDocument(document);
    if (!notebook) return undefined;
    const source = document.getText();
    const offset = document.offsetAt(position);
    const span = mathSpanAtOffset(source, offset);
    if (!span) {
      return undefined;
    }
    const rendered = await this.compileHoverSvg(span.expression, span.display, notebook);
    const markdown = new vscode.MarkdownString();
    if (rendered.svg) {
      const image = Buffer.from(rendered.svg, "utf8").toString("base64");
      markdown.appendMarkdown(`![Typst 公式](data:image/svg+xml;base64,${image})`);
    } else {
      markdown.appendCodeblock(rendered.error ?? "Typst 渲染失败", "text");
    }
    return new vscode.Hover(
      markdown,
      new vscode.Range(
        document.positionAt(span.start),
        document.positionAt(span.end),
      ),
    );
  }

  private async compileHoverSvg(
    expression: string,
    display: boolean,
    notebook: vscode.NotebookDocument,
  ): Promise<TypstSvgResult> {
    const foreground = (
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
        ? "#1F2328"
        : "#E6EDF3"
    );
    const normalizedExpression = normalizeTypstMathExpression(expression);
    const key = createHash("sha1")
      .update(`hover-svg\0${foreground}\0${display}\0${normalizedExpression}`, "utf8")
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) return JSON.parse(cached) as TypstSvgResult;

    const source = `#set page(width: auto, height: auto, margin: 6pt, fill: none)
#set text(size: 16pt, fill: rgb("${escapeTypstString(foreground)}"))
$ ${normalizedExpression} $
`;
    const executable = (await this.typstExecutable?.(notebook)) || "typst";
    let result: TypstProcessResult;
    try {
      result = await runTypst(executable, source, "svg");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Typst 启动失败：${message}` };
    }
    if (result.timedOut) {
      return { error: `Typst 编译超过 ${TYPST_TIMEOUT_MS / 1000} 秒，已停止。` };
    }
    if (result.overflow) return { error: "Typst 输出超过 4 MiB，已停止读取。" };
    const svg = result.stdout.trim();
    if (result.status !== 0 || !svg.startsWith("<svg")) {
      return {
        error: (result.stderr || "Typst 没有生成 SVG 公式。")
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim()
          .slice(-1200),
      };
    }
    const compiled: TypstSvgResult = { svg };
    this.cache.set(key, JSON.stringify(compiled));
    return compiled;
  }

  private completions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionList | undefined {
    if (!this.notebookForDocument(document)) return undefined;
    const source = document.getText();
    const offset = document.offsetAt(position);
    const word = typstMathWordAtOffset(source, offset);
    if (!word) return undefined;
    const range = new vscode.Range(
      document.positionAt(word.start),
      document.positionAt(word.end),
    );
    const items = typstMathSuggestions(word.prefix).map((suggestion, index) => {
      const item = new vscode.CompletionItem(
        {
          label: suggestion.label,
          description: `${suggestion.glyph} · ${suggestion.detail}`,
        },
        suggestion.snippet
          ? vscode.CompletionItemKind.Snippet
          : vscode.CompletionItemKind.Operator,
      );
      item.range = range;
      item.insertText = suggestion.snippet
        ? new vscode.SnippetString(suggestion.insertText)
        : suggestion.insertText;
      item.filterText = [suggestion.label, ...suggestion.aliases].join(" ");
      item.sortText = index.toString().padStart(3, "0");
      const documentation = new vscode.MarkdownString();
      documentation.appendMarkdown(`**${suggestion.glyph} ${suggestion.detail}**\n\n`);
      documentation.appendCodeblock(
        suggestion.insertText.replace(/\$\{\d+:([^}]+)\}/g, "$1"),
        "typst",
      );
      item.documentation = documentation;
      return item;
    });
    return new vscode.CompletionList(items, false);
  }
}
