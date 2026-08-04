import * as vscode from "vscode";
import {
  DEFAULT_CELL_SETTINGS,
  buildSceneCell,
  isManimSceneClass,
  rawManimCellMetadata,
  rawPythonCellMetadata,
} from "./core";

export const MANIM_NOTEBOOK_TYPE = "manim-jupyter-notebook";
export const MANIM_NOTEBOOK_SCHEMA_VERSION = 6;
const MANIM_VIDEO_MIME = "application/vnd.manim.video+json";

interface RawNotebookCell {
  type?: unknown;
  source?: unknown;
  metadata?: unknown;
  outputs?: unknown;
  execution_count?: unknown;
}

interface RawNotebook {
  format?: unknown;
  version?: unknown;
  cells?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceText(value: unknown): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").join("")
      : "";
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
    const text = typeof content === "string"
      ? content
      : content === undefined
        ? ""
        : JSON.stringify(content);
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
      text: Buffer.from(item.data).toString("utf8"),
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
    if (item.mime === MANIM_VIDEO_MIME || item.mime === "application/json") {
      try {
        data[item.mime] = JSON.parse(text);
        continue;
      } catch {
        // Keep malformed JSON as text instead of dropping user output.
      }
    }
    data[item.mime] = text;
  }
  const serialized: Record<string, unknown> = { output_type: "display_data", data };
  if (output.metadata && Object.keys(output.metadata).length) {
    serialized.metadata = output.metadata;
  }
  return serialized;
}

function canonicalDiskCellMetadata(
  metadata: Record<string, unknown>,
  kind: vscode.NotebookCellKind,
): Record<string, unknown> {
  if (kind === vscode.NotebookCellKind.Markup) {
    return { manimJupyterTypst: true };
  }
  if (metadata.manimJupyter !== undefined) {
    return { manimJupyter: metadata.manimJupyter };
  }
  return rawPythonCellMetadata(metadata);
}

export class ManimNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const source = Buffer.from(content).toString("utf8");
    if (!source.trim()) {
      const cell = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        buildSceneCell("WelcomeScene"),
        "python",
      );
      cell.metadata = { metadata: rawManimCellMetadata(DEFAULT_CELL_SETTINGS) };
      return new vscode.NotebookData([cell]);
    }
    let raw: RawNotebook;
    try {
      raw = JSON.parse(source) as RawNotebook;
    } catch (error) {
      throw new Error(`Invalid *.manim.ipynb JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      raw.format !== "manim-jupyter" ||
      raw.version !== MANIM_NOTEBOOK_SCHEMA_VERSION
    ) {
      throw new Error(
        `This development build only supports canonical *.manim.ipynb schema v${MANIM_NOTEBOOK_SCHEMA_VERSION}.`,
      );
    }
    const rawCells = Array.isArray(raw.cells) ? raw.cells as RawNotebookCell[] : [];
    const cells = rawCells.map((cell) => {
      const kind = cell.type === "markdown"
        ? vscode.NotebookCellKind.Markup
        : vscode.NotebookCellKind.Code;
      const data = new vscode.NotebookCellData(
        kind,
        sourceText(cell.source),
        kind === vscode.NotebookCellKind.Markup ? "markdown" : "python",
      );
      const diskMetadata = record(cell.metadata);
      if (
        kind === vscode.NotebookCellKind.Code &&
        diskMetadata.manimJupyter !== undefined &&
        !isManimSceneClass(record(diskMetadata.manimJupyter).sceneClass)
      ) {
        throw new Error("Invalid Manim Cell sceneClass.");
      }
      data.metadata = { metadata: canonicalDiskCellMetadata(diskMetadata, kind) };
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
    return new vscode.NotebookData(cells);
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const cells = data.cells.map((cell) => {
      const diskMetadata = record(record(cell.metadata).metadata);
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        return {
          type: "markdown",
          source: cell.value,
          metadata: { manimJupyterTypst: true },
        };
      }
      let metadata: Record<string, unknown>;
      if (diskMetadata.manimJupyter !== undefined) {
        if (!isManimSceneClass(record(diskMetadata.manimJupyter).sceneClass)) {
          throw new Error("Invalid Manim Cell sceneClass.");
        }
        metadata = { manimJupyter: diskMetadata.manimJupyter };
      } else {
        metadata = rawPythonCellMetadata(diskMetadata);
      }
      return {
        type: "code",
        execution_count: cell.executionSummary?.executionOrder ?? null,
        metadata,
        outputs: (cell.outputs ?? []).map(serializeOutput),
        source: cell.value,
      };
    });
    return Buffer.from(JSON.stringify({
      format: "manim-jupyter",
      version: MANIM_NOTEBOOK_SCHEMA_VERSION,
      cells,
    }, null, 2), "utf8");
  }
}
