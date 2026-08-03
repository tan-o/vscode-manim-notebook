import * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CELL_SETTINGS,
  buildSceneCell,
  readManimCellSettings,
  rawPythonCellMetadata,
  rawManimCellMetadata,
} from "./core";

export const MANIM_NOTEBOOK_TYPE = "manim-jupyter-notebook";
export const MANIM_NOTEBOOK_SCHEMA_VERSION = 4;
const MANIM_VIDEO_MIME = "application/vnd.manim.video+json";

interface ManimVideoDescriptor {
  path?: unknown;
  mimeType?: unknown;
  autoplay?: unknown;
  loop?: unknown;
  controls?: unknown;
  playbackRate?: unknown;
  width?: unknown;
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializedVideoHtml(data: Uint8Array): string | undefined {
  try {
    const descriptor = JSON.parse(Buffer.from(data).toString("utf8")) as ManimVideoDescriptor;
    if (typeof descriptor.path !== "string" || !descriptor.path.trim()) return undefined;
    const source = htmlAttribute(pathToFileURL(descriptor.path).href);
    const mimeType = htmlAttribute(typeof descriptor.mimeType === "string" ? descriptor.mimeType : "video/mp4");
    const width = typeof descriptor.width === "string" && /^(?:\d+(?:\.\d+)?)(?:%|px|rem|em|vw)$/.test(descriptor.width)
      ? descriptor.width
      : "100%";
    const loop = descriptor.loop === true;
    const controls = descriptor.controls !== false;
    const rate = typeof descriptor.playbackRate === "number" && Number.isFinite(descriptor.playbackRate)
      ? Math.max(0.1, descriptor.playbackRate)
      : 1;
    const attributes = [
      controls ? "controls" : "",
      "autoplay muted",
      loop ? "loop" : "",
      "playsinline preload=\"auto\"",
    ].filter(Boolean).join(" ");
    return `<video ${attributes} style="display:block;max-width:100%;max-height:82vh;width:${htmlAttribute(width)};margin:0 auto;object-fit:contain" onloadedmetadata="this.playbackRate=${rate};"><source src="${source}" type="${mimeType}"></video>`;
  } catch {
    return undefined;
  }
}

interface RawNotebookCell {
  cell_type?: unknown;
  source?: unknown;
  metadata?: unknown;
  outputs?: unknown;
  execution_count?: unknown;
}

interface RawNotebook {
  cells?: unknown;
  metadata?: unknown;
  nbformat?: unknown;
  nbformat_minor?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("");
  }
  return "";
}

function splitSource(value: string): string[] {
  return value ? value.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [value] : [];
}

function canonicalDiskCellMetadata(
  metadata: Record<string, unknown>,
  kind: vscode.NotebookCellKind,
): Record<string, unknown> {
  if (kind === vscode.NotebookCellKind.Markup) {
    return {
      ...metadata,
      manimJupyterTypst: true,
      slideshow: { slide_type: "skip" },
    };
  }
  if (metadata.manimJupyterCellType === "manim") {
    return {
      ...metadata,
      ...rawManimCellMetadata(readManimCellSettings({ metadata })),
      vscode: { ...record(metadata.vscode), languageId: "python" },
    };
  }
  return rawPythonCellMetadata(metadata);
}

function outputItems(value: unknown): vscode.NotebookCellOutputItem[] {
  const output = record(value);
  const outputType = output.output_type;
  if (outputType === "stream") {
    const stream = sourceText(output.text);
    return [output.name === "stderr"
      ? vscode.NotebookCellOutputItem.stderr(stream)
      : vscode.NotebookCellOutputItem.stdout(stream)];
  }
  if (outputType === "error") {
    const name = typeof output.ename === "string" ? output.ename : "Error";
    const message = typeof output.evalue === "string" ? output.evalue : "Notebook execution failed";
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.filter((line): line is string => typeof line === "string").join("\n")
      : message;
    return [vscode.NotebookCellOutputItem.error({ name, message, stack: traceback })];
  }
  const data = record(output.data);
  return Object.entries(data).map(([mime, content]) => {
    if (mime.startsWith("image/") && typeof content === "string") {
      return new vscode.NotebookCellOutputItem(Buffer.from(content, "base64"), mime);
    }
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return new vscode.NotebookCellOutputItem(Buffer.from(text, "utf8"), mime);
  });
}

function deserializeOutput(value: unknown): vscode.NotebookCellOutput | undefined {
  const items = outputItems(value);
  return items.length ? new vscode.NotebookCellOutput(items, record(record(value).metadata)) : undefined;
}

function serializeOutput(output: vscode.NotebookCellOutput): Record<string, unknown> {
  const error = output.items.find((item) => item.mime === "application/vnd.code.notebook.error");
  if (error) {
    try {
      const value = JSON.parse(Buffer.from(error.data).toString("utf8")) as {
        name?: string;
        message?: string;
        stack?: string;
      };
      return {
        output_type: "error",
        ename: value.name ?? "Error",
        evalue: value.message ?? "Notebook execution failed",
        traceback: (value.stack ?? value.message ?? "").split(/\r?\n/),
      };
    } catch {
      return { output_type: "error", ename: "Error", evalue: "Notebook execution failed", traceback: [] };
    }
  }
  const stdout = output.items.find((item) => item.mime === "application/x.notebook.stream.stdout");
  const stderr = output.items.find((item) => item.mime === "application/x.notebook.stream.stderr");
  if (stdout || stderr) {
    const item = stderr ?? stdout!;
    return {
      output_type: "stream",
      name: stderr ? "stderr" : "stdout",
      text: splitSource(Buffer.from(item.data).toString("utf8")),
    };
  }
  const data: Record<string, unknown> = {};
  for (const item of output.items) {
    const content = Buffer.from(item.data);
    if (item.mime.startsWith("image/")) {
      data[item.mime] = content.toString("base64");
      continue;
    }
    const text = content.toString("utf8");
    if (item.mime === "application/json") {
      try {
        data[item.mime] = JSON.parse(text);
        continue;
      } catch {
        // Preserve invalid JSON as text instead of dropping user output.
      }
    }
    data[item.mime] = text;
  }
  const manimVideo = output.items.find((item) => item.mime === MANIM_VIDEO_MIME);
  if (manimVideo) {
    const html = serializedVideoHtml(manimVideo.data);
    if (html) data["text/html"] = html;
  }
  return { output_type: "display_data", data, metadata: output.metadata ?? {} };
}

export class ManimNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const source = Buffer.from(content).toString("utf8");
    if (!source.trim()) {
      const cell = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        buildSceneCell("WelcomeScene"),
        "manim",
      );
      cell.metadata = { metadata: rawManimCellMetadata(DEFAULT_CELL_SETTINGS) };
      const notebook = new vscode.NotebookData([cell]);
      notebook.metadata = {
        manimJupyter: {
          version: MANIM_NOTEBOOK_SCHEMA_VERSION,
          oneCellOneSlide: true,
        },
        language_info: { name: "python" },
      };
      return notebook;
    }
    let raw: RawNotebook;
    try {
      raw = JSON.parse(source) as RawNotebook;
    } catch (error) {
      throw new Error(`Invalid *.manim.ipynb JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const notebookMetadata = record(raw.metadata);
    const schema = record(notebookMetadata.manimJupyter);
    if (raw.nbformat !== 4 || schema.version !== MANIM_NOTEBOOK_SCHEMA_VERSION) {
      throw new Error(
        `This development build only supports canonical *.manim.ipynb schema v${MANIM_NOTEBOOK_SCHEMA_VERSION}.`,
      );
    }
    const rawCells = Array.isArray(raw.cells) ? raw.cells as RawNotebookCell[] : [];
    const cells = rawCells.map((cell) => {
      const kind = cell.cell_type === "markdown"
        ? vscode.NotebookCellKind.Markup
        : vscode.NotebookCellKind.Code;
      const diskMetadata = canonicalDiskCellMetadata(record(cell.metadata), kind);
      const language = kind === vscode.NotebookCellKind.Markup ? "markdown" : "python";
      const data = new vscode.NotebookCellData(kind, sourceText(cell.source), language);
      data.metadata = { metadata: diskMetadata };
      if (kind === vscode.NotebookCellKind.Code) {
        data.executionSummary = typeof cell.execution_count === "number"
          ? { executionOrder: cell.execution_count }
          : undefined;
        data.outputs = (Array.isArray(cell.outputs) ? cell.outputs : [])
          .map(deserializeOutput)
          .filter((item): item is vscode.NotebookCellOutput => Boolean(item));
      }
      return data;
    });
    const notebook = new vscode.NotebookData(cells);
    notebook.metadata = {
      ...notebookMetadata,
      language_info: { ...record(notebookMetadata.language_info), name: "python" },
    };
    return notebook;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const metadata = {
      ...record(data.metadata),
      manimJupyter: {
        ...record(record(data.metadata).manimJupyter),
        version: MANIM_NOTEBOOK_SCHEMA_VERSION,
        oneCellOneSlide: true,
      },
      language_info: { ...record(record(data.metadata).language_info), name: "python" },
    };
    const cells = data.cells.map((cell) => {
      const diskMetadata = record(record(cell.metadata).metadata);
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        return {
          cell_type: "markdown",
          metadata: canonicalDiskCellMetadata(diskMetadata, cell.kind),
          source: splitSource(cell.value),
        };
      }
      const metadataForDisk = diskMetadata.manimJupyterCellType === "manim"
        ? canonicalDiskCellMetadata(diskMetadata, cell.kind)
        : rawPythonCellMetadata(diskMetadata);
      return {
        cell_type: "code",
        execution_count: cell.executionSummary?.executionOrder ?? null,
        metadata: metadataForDisk,
        outputs: (cell.outputs ?? []).map(serializeOutput),
        source: splitSource(cell.value),
      };
    });
    return Buffer.from(JSON.stringify({
      cells,
      metadata,
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 2), "utf8");
  }
}
