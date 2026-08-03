import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { isManimCellMetadata, isManimNotebookPath, mathSpanAtOffset } from "./core";
import {
  normalizeTypstMathExpression,
  typstMathPythonContextAtOffset,
  typstMathPythonWordAtOffset,
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

function runTypst(executable: string, source: string): Promise<TypstProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["compile", "--features", "html", "--format", "html", "-", "-"],
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
        scheme: "vscode-notebook-cell",
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
      vscode.languages.registerCompletionItemProvider(
        [
          {
            language: "python",
            notebookType: MANIM_NOTEBOOK_TYPE,
            scheme: "vscode-notebook-cell",
          },
        ],
        {
          provideCompletionItems: (document, position) =>
            this.pythonCompletions(document, position),
        },
        ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._".split(""),
      ),
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
    const rendered = await this.compile(span.expression, span.display, undefined, notebook);
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.supportHtml = true;
    if (rendered.mathml) {
      markdown.appendMarkdown(
        `<div style="font-size:1.15em;padding:6px 10px;border:1px solid var(--vscode-panel-border);border-radius:4px">${rendered.mathml}</div>`,
      );
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

  private pythonCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionList | undefined {
    const notebook = this.notebookForDocument(document);
    if (!notebook) return undefined;
    const cell = notebook.getCells().find(
      (candidate) => candidate.document.uri.toString() === document.uri.toString(),
    );
    if (!cell || !isManimCellMetadata(cell.metadata)) return undefined;
    const source = document.getText();
    const offset = document.offsetAt(position);
    const context = typstMathPythonContextAtOffset(source, offset);
    if (!context) return undefined;
    const word = typstMathPythonWordAtOffset(source, offset);
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
