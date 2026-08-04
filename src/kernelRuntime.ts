import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createInterface, Interface as ReadlineInterface } from "node:readline";
import * as vscode from "vscode";
import {
  DEFAULT_CELL_SETTINGS,
  ManimCellSettings,
  ManimCellFragment,
  ManimNotebookSettings,
  ManimSceneClass,
  buildMagicArguments,
  canonicalManimCellSource,
  combineManimCellSources,
  groupManimSceneSegments,
  isManimCellMetadata,
  isManimCellSource,
  previewAtLine,
  previewRenderSettings,
  readManimCellSceneClass,
  readManimCellSettings,
  repairRevealConfig,
  sceneNameForBody,
} from "./core";
import {
  PYTHON_PACKAGES,
  PythonEnvironmentReport,
  PythonPackageId,
} from "./environment";

export const MANIM_VIDEO_MIME = "application/vnd.manim.video+json";
const WORKER_PREFIX = "__MANIM_JUPYTER_JSON__";
const ENVIRONMENT_PREFIX = "__MANIM_JUPYTER_ENVIRONMENT__";
const EXECUTION_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const SUBPROCESS_OUTPUT_LIMIT = 4 * 1024 * 1024;

const LINE_PREVIEW_SCENE_CLASSES: Record<ManimSceneClass, string> = {
  Scene: "_ManimJupyterManimScene",
  ThreeDScene: "_ManimJupyterManimThreeDScene",
  MovingCameraScene: "_ManimJupyterManimMovingCameraScene",
  ZoomedScene: "_ManimJupyterManimZoomedScene",
  VectorScene: "_ManimJupyterManimVectorScene",
  LinearTransformationScene: "_ManimJupyterManimLinearTransformationScene",
  SpecialThreeDScene: "_ManimJupyterSpecialThreeDPreview",
};

export interface KernelOutputItem {
  mime: string;
  data: Uint8Array;
}

export interface KernelOutput {
  items: KernelOutputItem[];
  metadata?: Record<string, unknown>;
}

export interface LinePreviewResult {
  outputs: KernelOutput[];
  statement: string;
  kind: "animation" | "object";
  animationIndex?: number;
  objectName?: string;
}

export type ManimRenderStage =
  | "rendering"
  | "packaging"
  | "saving"
  | "converting"
  | "loading";

export interface ManimRenderProgress {
  stage: ManimRenderStage;
  animation?: number;
  description?: string;
  current?: number;
  total?: number;
  percent?: number;
  fps?: number;
  realtime?: number;
  elapsed?: number;
  eta?: number;
  skipped?: boolean;
  done?: boolean;
}

export type ManimRenderProgressListener = (value: ManimRenderProgress) => void;

export type ManimCellRunState = "preparing" | "rendering";

type ManimProgressReporter = (state: ManimCellRunState, message: string) => void;

interface PythonEnvironment {
  readonly id: string;
  readonly path: string;
  readonly executable?: { readonly uri?: vscode.Uri };
  readonly environment?: { readonly name?: string; readonly type?: string };
  readonly version?: { readonly major?: number; readonly minor?: number; readonly micro?: number };
}

interface PythonApi {
  readonly ready: Promise<void>;
  readonly environments: {
    readonly known: readonly PythonEnvironment[];
    readonly onDidChangeEnvironments: vscode.Event<unknown>;
    refreshEnvironments(options?: { forceRefresh?: boolean }, token?: vscode.CancellationToken): Promise<void>;
    resolveEnvironment(environment: PythonEnvironment | string): Promise<PythonEnvironment | undefined>;
  };
}

interface PythonSpec {
  id: string;
  executable: string;
  label: string;
  detail: string;
}

interface WorkerItem {
  mime?: unknown;
  value?: unknown;
  base64?: unknown;
}

interface WorkerOutput {
  items?: WorkerItem[];
  metadata?: unknown;
}

interface WorkerResponse {
  id?: unknown;
  type?: unknown;
  message?: unknown;
  ok?: unknown;
  outputs?: WorkerOutput[];
  executionOrder?: unknown;
  progress?: unknown;
}

interface PendingRequest {
  resolve(response: WorkerResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  onProgress?: ManimRenderProgressListener;
}

interface ProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Launching a Conda interpreter by its absolute python.exe path does not
 * activate the environment. On Windows that means native libraries and tools
 * in Library\bin (for example Cairo/FFmpeg dependencies) cannot be found. Build the
 * small, deterministic subset of activation state that subprocesses need.
 */
function pythonProcessEnvironment(executable: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
  };
  if (process.platform !== "win32") return environment;

  const prefix = path.dirname(executable);
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const searchPath = [
    prefix,
    path.join(prefix, "Scripts"),
    path.join(prefix, "Library", "bin"),
    environment[pathKey] ?? "",
  ].filter(Boolean).join(path.delimiter);
  environment[pathKey] = searchPath;
  environment.CONDA_PREFIX = environment.CONDA_PREFIX || prefix;
  return environment;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workerProgress(value: unknown): ManimRenderProgress | undefined {
  const payload = record(value);
  const stage = payload.stage;
  if (
    stage !== "rendering" &&
    stage !== "packaging" &&
    stage !== "saving" &&
    stage !== "converting" &&
    stage !== "loading"
  ) {
    return undefined;
  }
  return {
    stage,
    animation: finiteNumber(payload.animation),
    description: typeof payload.description === "string" ? payload.description : undefined,
    current: finiteNumber(payload.current),
    total: finiteNumber(payload.total),
    percent: finiteNumber(payload.percent),
    fps: finiteNumber(payload.fps),
    realtime: finiteNumber(payload.realtime),
    elapsed: finiteNumber(payload.elapsed),
    eta: finiteNumber(payload.eta),
    skipped: payload.skipped === true,
    done: payload.done === true,
  };
}

function conciseDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatManimRenderProgress(value: ManimRenderProgress): string {
  const percent = value.percent === undefined
    ? undefined
    : `${Math.max(0, Math.min(100, value.percent)).toFixed(0)}%`;
  const elapsed = conciseDuration(value.elapsed);
  const eta = conciseDuration(value.eta);
  if (value.stage === "rendering") {
    const parts = [
      value.animation === undefined ? "正在渲染动画" : `动画 ${value.animation}`,
      value.total !== undefined && value.current !== undefined
        ? `${Math.round(value.current)}/${Math.round(value.total)} 帧`
        : value.current !== undefined
          ? `${Math.round(value.current)} 帧`
          : undefined,
      percent,
      value.fps !== undefined && value.fps > 0 ? `${value.fps.toFixed(1)} fps` : undefined,
      value.realtime !== undefined && value.realtime > 0
        ? `${value.realtime.toFixed(2)}× 实时`
        : undefined,
      elapsed ? `已用 ${elapsed}` : undefined,
      eta && !value.done ? `ETA ${eta}` : undefined,
      value.skipped ? "跳过帧" : undefined,
    ].filter((part): part is string => Boolean(part));
    return parts.join(" · ");
  }
  if (value.stage === "packaging") {
    return [
      value.total !== undefined && value.current !== undefined
        ? `正在生成 PPT 页面 ${Math.round(value.current)}/${Math.round(value.total)}`
        : "正在生成 PPT 页面",
      percent,
      eta && !value.done ? `ETA ${eta}` : undefined,
      elapsed ? `已用 ${elapsed}` : undefined,
    ].filter((part): part is string => Boolean(part)).join(" · ");
  }
  if (value.stage === "saving") {
    return ["正在写入 PowerPoint 文件", percent, elapsed ? `已用 ${elapsed}` : undefined]
      .filter((part): part is string => Boolean(part)).join(" · ");
  }
  if (value.stage === "converting") {
    return value.description || "正在生成 HTML Slides";
  }
  return value.description || "正在载入渲染结果";
}

function outputText(item: KernelOutputItem): string {
  return Buffer.from(item.data).toString("utf8");
}

function cleanAnsiText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\\u001b\[[0-9;?]*[ -/]*[@-~]/gi, "")
    .trim();
}

function outputError(item: KernelOutputItem): Error {
  const raw = outputText(item);
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof parsed.name === "string" ? cleanAnsiText(parsed.name) : "PythonError";
    const message = typeof parsed.message === "string"
      ? cleanAnsiText(parsed.message)
      : "Python execution failed";
    const error = new Error(message.slice(-1800));
    error.name = name;
    return error;
  } catch {
    return new Error(cleanAnsiText(raw).slice(-6000));
  }
}

function cleanProcessDetail(value: Buffer): string {
  return value.toString("utf8")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim()
    .slice(-4000);
}

/**
 * Rewrite a generated Manim Slides HTML file for native playback inside a VS
 * Code webview: local assets become webview URIs, CDN assets stay untouched,
 * and a small toolbar offers opening the same file in the system browser.
 */
function slidesWebviewHtml(
  webview: vscode.Webview,
  html: string,
  destination: string,
  folder: string,
  revealRoot: string,
): string {
  const destinationDir = path.dirname(destination);
  html = repairRevealConfig(html);
  const rewriteUrl = (url: string): string => {
      const trimmed = url.trim();
      // Bundled reveal.js replaces the CDN so presentations play offline.
      const cdnMatch = /^https:\/\/cdn\.jsdelivr\.net\/npm\/reveal\.js@[^/]+\/(dist\/.*)$/i.exec(trimmed);
      if (cdnMatch) {
        const local = path.join(revealRoot, cdnMatch[1].replace(/\//g, path.sep));
        if (existsSync(local)) {
          return webview.asWebviewUri(vscode.Uri.file(local)).toString();
        }
      }
      if (
        /^(https?:|data:|blob:|#)/i.test(trimmed)
      ) {
        return url;
      }
      let candidate: string | undefined;
      if (/^file:/i.test(trimmed)) {
        try {
          candidate = vscode.Uri.parse(trimmed).fsPath;
        } catch {
          candidate = undefined;
        }
      } else {
        candidate = path.resolve(destinationDir, decodeURIComponent(trimmed.split(/[?#]/, 1)[0]));
      }
      const relative = candidate ? path.relative(folder, candidate) : "";
      if (
        candidate &&
        (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) &&
        existsSync(candidate)
      ) {
        return webview.asWebviewUri(vscode.Uri.file(candidate)).toString();
      }
      return url;
  };
  const rewritten = html.replace(
    /(\s(?:src|href|poster|data-background-video|data-background-image)=")([^"]+)(")/g,
    (_match, prefix: string, url: string, suffix: string) =>
      `${prefix}${rewriteUrl(url)}${suffix}`,
  );
  const nonce = Math.random().toString(36).slice(2);
  const csp = webview.cspSource;
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob: https:; media-src ${csp} blob: https:; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline'; font-src ${csp} data:;">`;
  const toolbar = `<div style="position:fixed;z-index:9999;top:10px;right:12px;display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:color-mix(in srgb,var(--vscode-editor-background) 85%,transparent);color:var(--vscode-foreground);font:12px var(--vscode-font-family);box-shadow:0 2px 10px rgba(0,0,0,.25)">
  <span>方向键 / 空格翻页 · Esc 退出全屏</span>
  <button id="manim-slides-enter-fullscreen" style="cursor:pointer">全屏</button>
  <button id="manim-slides-exit-fullscreen" style="display:none;cursor:pointer">退出全屏</button>
  <button id="manim-slides-open-browser" style="cursor:pointer">在浏览器中打开</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let slidesFullscreen = false;
  const enterFullscreenButton = document.getElementById('manim-slides-enter-fullscreen');
  const exitFullscreenButton = document.getElementById('manim-slides-exit-fullscreen');
  const setFullscreenUi = (enabled) => {
    slidesFullscreen = enabled;
    enterFullscreenButton.style.display = enabled ? 'none' : '';
    exitFullscreenButton.style.display = enabled ? '' : 'none';
  };
  enterFullscreenButton.addEventListener('click', () => {
    setFullscreenUi(true);
    vscode.postMessage({ type: 'enterFullscreen' });
  });
  exitFullscreenButton.addEventListener('click', () => {
    setFullscreenUi(false);
    vscode.postMessage({ type: 'exitFullscreen' });
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && slidesFullscreen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setFullscreenUi(false);
      vscode.postMessage({ type: 'exitFullscreen' });
    }
  }, true);
  document.getElementById('manim-slides-open-browser').addEventListener('click', () => {
    vscode.postMessage({ type: 'openExternal' });
  });
</script>`;
  return rewritten
    .replace(/<head[^>]*>/i, (head) => `${head}${meta}`)
    .replace(/<body[^>]*>/i, (body) => `${body}${toolbar}`);
}

function workerOutputs(response: WorkerResponse): KernelOutput[] {
  return (Array.isArray(response.outputs) ? response.outputs : []).map((output) => ({
    items: (Array.isArray(output.items) ? output.items : [])
      .filter((value): value is WorkerItem & { mime: string } => typeof value.mime === "string")
      .map((value) => {
        const data = value.base64 === true && typeof value.value === "string"
          ? Buffer.from(value.value, "base64")
          : Buffer.from(typeof value.value === "string" ? value.value : JSON.stringify(value.value), "utf8");
        return { mime: value.mime, data };
      }),
    metadata: record(output.metadata),
  }));
}

function toNotebookItem(value: KernelOutputItem): vscode.NotebookCellOutputItem {
  if (value.mime === "application/x.notebook.stream.stdout") {
    return vscode.NotebookCellOutputItem.stdout(outputText(value));
  }
  if (value.mime === "application/x.notebook.stream.stderr") {
    return vscode.NotebookCellOutputItem.stderr(outputText(value));
  }
  if (value.mime === "application/vnd.code.notebook.error") {
    try {
      const error = JSON.parse(outputText(value)) as { name?: string; message?: string; stack?: string };
      return vscode.NotebookCellOutputItem.error({
        name: error.name ?? "Error",
        message: error.message ?? "Python execution failed",
        stack: error.stack,
      });
    } catch {
      return vscode.NotebookCellOutputItem.error({ name: "Error", message: outputText(value) });
    }
  }
  return new vscode.NotebookCellOutputItem(value.data, value.mime);
}

function toNotebookOutput(value: KernelOutput): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput(value.items.map(toNotebookItem), value.metadata);
}

class PythonWorker implements vscode.Disposable {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private nextId = 0;
  private stderr = "";
  private disposed = false;

  constructor(executable: string, script: string, cwd: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.process = spawn(executable, ["-u", script], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonProcessEnvironment(executable),
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.process.stderr.on("data", (value: Buffer) => {
      this.stderr = `${this.stderr}${value.toString("utf8")}`.slice(-8000);
    });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) => {
      if (!this.disposed) {
        this.fail(new Error(
          `Python worker exited (${signal ?? code ?? "unknown"}).${this.stderr ? `\n${this.stderr}` : ""}`,
        ));
      }
    });
  }

  get isAlive(): boolean {
    return !this.disposed && this.process.exitCode === null && !this.process.killed;
  }

  async execute(
    code: string,
    storeHistory = false,
    onProgress?: ManimRenderProgressListener,
  ): Promise<WorkerResponse> {
    await this.ready;
    if (!this.isAlive) throw new Error("The selected Jupyter kernel is not running.");
    const id = ++this.nextId;
    const response = new Promise<WorkerResponse>((resolve, reject) => {
      const timer = this.createInactivityTimer(id);
      this.pending.set(id, { resolve, reject, timer, onProgress });
    });
    this.process.stdin.write(`${JSON.stringify({ id, code, storeHistory })}\n`, "utf8");
    return response;
  }

  private createInactivityTimer(id: number): NodeJS.Timeout {
    return setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new Error("Kernel 连续 15 分钟没有报告任何进度，已中断执行。"));
      this.interrupt();
    }, EXECUTION_INACTIVITY_TIMEOUT_MS);
  }

  interrupt(): void {
    if (!this.isAlive) return;
    try {
      this.process.stdin.write(`${JSON.stringify({ type: "interrupt" })}\n`, "utf8");
    } catch {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.process.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`, "utf8");
    } catch {
      // The process may already have closed its input pipe.
    }
    this.fail(new Error("The selected Jupyter kernel was stopped."));
    if (this.process.exitCode === null) {
      // Give the gateway time to stop its child IPykernel cleanly.  A hard
      // kill remains as a bounded fallback for a wedged native renderer.
      const timer = setTimeout(() => {
        if (this.process.exitCode === null) this.process.kill();
      }, 2_000);
      timer.unref();
      this.process.once("exit", () => clearTimeout(timer));
    }
  }

  private onLine(line: string): void {
    if (!line.startsWith(WORKER_PREFIX)) return;
    let response: WorkerResponse;
    try {
      response = JSON.parse(line.slice(WORKER_PREFIX.length)) as WorkerResponse;
    } catch {
      return;
    }
    if (response.type === "ready") {
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (response.type === "startupError") {
      this.fail(new Error(
        typeof response.message === "string"
          ? response.message
          : "Unable to start the selected Jupyter kernel.",
      ));
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type === "progress") {
      clearTimeout(pending.timer);
      pending.timer = this.createInactivityTimer(response.id);
      const progress = workerProgress(response.progress);
      if (progress) pending.onProgress?.(progress);
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function environmentLabel(environment: PythonEnvironment, executable: string): string {
  const name = environment.environment?.name?.trim() || path.basename(path.dirname(executable));
  const version = environment.version?.major !== undefined
    ? `Python ${environment.version.major}.${environment.version.minor ?? 0}.${environment.version.micro ?? 0}`
    : "Python";
  return `${name} (${version})`;
}

/** Indent every non-blank source line for embedding inside `def construct`. */
function indentSourceLines(source: string, indent: string): string {
  return source.split(/\r?\n/)
    .map((line) => line.trim() ? `${indent}${line}` : "")
    .join("\n");
}

export class KernelRuntime implements vscode.Disposable {
  private pythonPromise: Promise<PythonApi> | undefined;
  private readonly controllers = new Map<string, vscode.NotebookController>();
  private readonly selectedSpecs = new Map<string, PythonSpec>();
  private readonly typstPaths = new Map<string, string | undefined>();
  private readonly workers = new Map<string, { specId: string; worker: PythonWorker }>();
  private readonly readyWorkers = new WeakSet<object>();
  private readonly initializing = new Map<string, Promise<boolean>>();
  private readonly disposables: vscode.Disposable[] = [];
  private controllerRefresh: Promise<void> | undefined;
  private linePreviewCancellation: vscode.CancellationTokenSource | undefined;
  private executionOrder = 0;
  private progressOperation = 0;
  private readonly cellProgressOperations = new Map<
    string,
    Map<number, ManimCellRunState>
  >();

  constructor(
    private readonly startupFile: vscode.Uri,
    private readonly workerFile: vscode.Uri,
    private readonly notebookType: string,
    private readonly settingsProvider: () => ManimNotebookSettings,
    private readonly cellSettingsProvider: (notebook: vscode.NotebookDocument) => Record<string, ManimCellSettings>,
    private readonly cellRunStateChanged: (
      cell: vscode.NotebookCell,
      state: ManimCellRunState | undefined,
    ) => void = () => undefined,
  ) {}

  dispose(): void {
    this.linePreviewCancellation?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    for (const controller of this.controllers.values()) controller.dispose();
    for (const entry of this.workers.values()) entry.worker.dispose();
    this.controllers.clear();
    this.workers.clear();
    this.typstPaths.clear();
  }

  async registerControllers(): Promise<void> {
    if (this.controllerRefresh) return this.controllerRefresh;
    this.controllerRefresh = this.refreshControllers().finally(() => {
      this.controllerRefresh = undefined;
    });
    return this.controllerRefresh;
  }

  isReady(notebook: vscode.NotebookDocument): boolean {
    const worker = this.workers.get(notebook.uri.toString())?.worker;
    return Boolean(worker?.isAlive && this.readyWorkers.has(worker as object));
  }

  private async python(): Promise<PythonApi> {
    if (!this.pythonPromise) {
      this.pythonPromise = (async () => {
        const extension = vscode.extensions.getExtension<PythonApi>("ms-python.python");
        if (!extension) throw new Error("The Microsoft Python extension is not installed.");
        const api = (extension.isActive ? extension.exports : await extension.activate()) as PythonApi;
        await api.ready;
        if (!api.environments) throw new Error("The Microsoft Python environment API is unavailable.");
        this.disposables.push(api.environments.onDidChangeEnvironments(() => void this.registerControllers()));
        return api;
      })().catch((error) => {
        this.pythonPromise = undefined;
        throw error;
      });
    }
    return this.pythonPromise;
  }

  private async refreshControllers(): Promise<void> {
    const api = await this.python();
    await api.environments.refreshEnvironments();
    const resolved = await Promise.all(api.environments.known.map(async (environment) =>
      await api.environments.resolveEnvironment(environment) ?? environment));
    const specs: PythonSpec[] = [];
    for (const environment of resolved) {
      const executable = environment.executable?.uri?.fsPath ||
        (/python(?:\.exe)?$/i.test(environment.path) ? environment.path : "");
      if (!executable) continue;
      specs.push({
        id: environment.id || executable.toLowerCase(),
        executable,
        label: environmentLabel(environment, executable),
        detail: executable,
      });
    }
    const unique = new Map(specs.map((spec) => [spec.id, spec]));
    for (const spec of unique.values()) {
      if (this.controllers.has(spec.id)) continue;
      const controller = vscode.notebooks.createNotebookController(
        `manim-python-${createHash("sha1").update(spec.id).digest("hex").slice(0, 16)}`,
        this.notebookType,
        spec.label,
        (cells) => this.executeCells(controller, cells),
      );
      controller.description = "Manim CE · Jupyter / IPykernel";
      controller.detail = spec.detail;
      // Every executable Cell keeps Python as its editor language for native
      // LSP behaviour. Explicit metadata, never source text or language,
      // selects the additional Manim execution path.
      controller.supportedLanguages = ["python"];
      controller.supportsExecutionOrder = true;
      controller.interruptHandler = (notebook) => {
        this.workers.get(notebook.uri.toString())?.worker.interrupt();
      };
      this.disposables.push(controller.onDidChangeSelectedNotebooks((event) => {
        const key = event.notebook.uri.toString();
        if (event.selected) {
          const previous = this.selectedSpecs.get(key);
          if (previous?.id !== spec.id) this.releaseWorker(key);
          this.selectedSpecs.set(key, spec);
        } else if (this.selectedSpecs.get(key)?.id === spec.id) {
          this.selectedSpecs.delete(key);
          this.releaseWorker(key);
        }
      }));
      this.controllers.set(spec.id, controller);
    }
    for (const [id, controller] of this.controllers) {
      if (unique.has(id)) continue;
      controller.dispose();
      this.controllers.delete(id);
    }
  }

  private releaseWorker(key: string): void {
    const entry = this.workers.get(key);
    this.workers.delete(key);
    this.typstPaths.delete(key);
    entry?.worker.dispose();
  }

  releaseNotebook(notebook: vscode.NotebookDocument): void {
    const key = notebook.uri.toString();
    this.initializing.delete(key);
    this.selectedSpecs.delete(key);
    this.releaseWorker(key);
  }

  private async selectedWorker(notebook: vscode.NotebookDocument): Promise<PythonWorker | undefined> {
    await this.registerControllers();
    const key = notebook.uri.toString();
    const spec = this.selectedSpecs.get(key);
    if (!spec) return undefined;
    const existing = this.workers.get(key);
    if (existing?.specId === spec.id && existing.worker.isAlive) return existing.worker;
    this.releaseWorker(key);
    const worker = new PythonWorker(spec.executable, this.workerFile.fsPath, this.notebookCwd(notebook));
    this.workers.set(key, { specId: spec.id, worker });
    return worker;
  }

  private notebookCwd(notebook: vscode.NotebookDocument): string {
    return notebook.uri.scheme === "file"
      ? path.dirname(notebook.uri.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(this.workerFile.fsPath);
  }

  private async selectedSpec(notebook: vscode.NotebookDocument): Promise<PythonSpec> {
    await this.registerControllers();
    const spec = this.selectedSpecs.get(notebook.uri.toString());
    if (!spec) throw new Error("请先在 Notebook 右上角选择一个 Python 环境。");
    return spec;
  }

  private async runSelectedPython(
    notebook: vscode.NotebookDocument,
    args: readonly string[],
    options: {
      token?: vscode.CancellationToken;
      timeoutMs?: number;
      outputLimit?: number;
    } = {},
  ): Promise<ProcessResult> {
    const spec = await this.selectedSpec(notebook);
    const child = spawn(spec.executable, [...args], {
      cwd: this.notebookCwd(notebook),
      windowsHide: true,
      env: pythonProcessEnvironment(spec.executable),
    });
    child.stdin.end();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    let cancelled = false;
    let timedOut = false;
    const limit = options.outputLimit ?? SUBPROCESS_OUTPUT_LIMIT;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const cancellation = options.token?.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 60_000);
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? -1));
      });
      if (cancelled) throw new Error("操作已取消。");
      if (timedOut) throw new Error("Python 子进程运行超时。");
      if (exceeded) throw new Error(`Python 子进程输出超过 ${Math.round(limit / 1024 / 1024)} MiB，已停止。`);
      return {
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  async inspectEnvironment(notebook: vscode.NotebookDocument): Promise<PythonEnvironmentReport> {
    const definitions = Object.fromEntries(
      Object.entries(PYTHON_PACKAGES).map(([id, value]) => [id, {
        module: value.module,
        distribution: value.distribution,
      }]),
    );
    const code = `import importlib.metadata as _metadata
import importlib.util as _util
import json as _json
import shutil as _shutil
import sys as _sys
_definitions = _json.loads(${JSON.stringify(JSON.stringify(definitions))})
_packages = {}
for _key, _value in _definitions.items():
    try:
        _installed = _util.find_spec(_value["module"]) is not None
    except (ImportError, AttributeError, ValueError):
        _installed = False
    _version = None
    if _installed:
        try:
            _version = _metadata.version(_value["distribution"])
        except _metadata.PackageNotFoundError:
            pass
    _packages[_key] = {"installed": _installed, "version": _version}
_report = {
    "executable": _sys.executable,
    "pythonVersion": ".".join(map(str, _sys.version_info[:3])),
    "packages": _packages,
    "pipAvailable": _util.find_spec("pip") is not None,
    "typstPath": _shutil.which("typst"),
}
print(${JSON.stringify(ENVIRONMENT_PREFIX)} + _json.dumps(_report, ensure_ascii=False))`;
    const result = await this.runSelectedPython(notebook, ["-c", code], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(cleanProcessDetail(result.stderr) || "无法检查所选 Python 环境。");
    }
    const line = result.stdout.toString("utf8").split(/\r?\n/)
      .find((candidate) => candidate.startsWith(ENVIRONMENT_PREFIX));
    if (!line) throw new Error("所选 Python 环境没有返回有效的能力报告。");
    const raw = JSON.parse(line.slice(ENVIRONMENT_PREFIX.length)) as Partial<PythonEnvironmentReport>;
    if (!raw.packages || typeof raw.executable !== "string" || typeof raw.pythonVersion !== "string") {
      throw new Error("所选 Python 环境返回了无效的能力报告。");
    }
    const packages = {} as PythonEnvironmentReport["packages"];
    for (const id of Object.keys(PYTHON_PACKAGES) as PythonPackageId[]) {
      const value = raw.packages[id];
      packages[id] = {
        installed: value?.installed === true,
        version: typeof value?.version === "string" ? value.version : undefined,
      };
    }
    const report: PythonEnvironmentReport = {
      executable: raw.executable,
      pythonVersion: raw.pythonVersion,
      packages,
      pipAvailable: raw.pipAvailable === true,
      typstPath: typeof raw.typstPath === "string" ? raw.typstPath : undefined,
    };
    this.typstPaths.set(notebook.uri.toString(), report.typstPath);
    return report;
  }

  async resolveTypstExecutable(notebook: vscode.NotebookDocument | undefined): Promise<string | undefined> {
    if (!notebook) return undefined;
    const key = notebook.uri.toString();
    if (this.typstPaths.has(key)) return this.typstPaths.get(key);
    try {
      const report = await this.inspectEnvironment(notebook);
      return report.typstPath;
    } catch {
      return undefined;
    }
  }

  async installPythonPackages(
    notebook: vscode.NotebookDocument,
    requirements: readonly string[],
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (!requirements.length) return;
    const result = await this.runSelectedPython(
      notebook,
      ["-m", "pip", "install", "--upgrade", ...requirements],
      { token, timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS, outputLimit: 16 * 1024 * 1024 },
    );
    if (result.exitCode !== 0) {
      throw new Error(cleanProcessDetail(result.stderr) || cleanProcessDetail(result.stdout) || "pip 安装失败。");
    }
  }

  private async executeCells(
    controller: vscode.NotebookController,
    cells: readonly vscode.NotebookCell[],
  ): Promise<void> {
    for (const original of cells) {
      if (original.kind !== vscode.NotebookCellKind.Code) continue;
      const cell = original.notebook.cellAt(original.index);
      const execution = controller.createNotebookCellExecution(cell);
      execution.executionOrder = ++this.executionOrder;
      execution.start(Date.now());
      await execution.clearOutput(cell);
      let success = false;
      const manim = isManimCellMetadata(cell.metadata);
      try {
        const run = async (
          report?: ManimProgressReporter,
          token?: vscode.CancellationToken,
        ): Promise<void> => {
          if (manim) {
            const ready = await this.ensureRuntime(
              cell.notebook,
              this.settingsProvider(),
              this.cellSettingsProvider(cell.notebook),
            );
            if (!ready) throw new Error("Select a Python environment from the notebook kernel picker first.");
            report?.("rendering", "正在渲染动画…");
          }
          const code = manim
            ? this.wholeCellCommand(
              combineManimCellSources(this.manimFragmentsThrough(cell), false),
              this.settingsProvider(),
              readManimCellSceneClass(cell.metadata),
              readManimCellSettings(cell.metadata),
            )
            : cell.document.getText();
          const outputs = await this.executeCode(
            cell.notebook,
            code,
            !manim,
            manim && report
              ? (value) => report("rendering", formatManimRenderProgress(value))
              : undefined,
            token,
          );
          const error = outputs.flatMap((output) => output.items)
            .find((output) => output.mime === "application/vnd.code.notebook.error");
          const finalOutputs = manim ? this.finalManimOutputs(outputs) : outputs;
          if (manim) report?.("rendering", "正在载入视频…");
          await execution.replaceOutput(finalOutputs.map(toNotebookOutput), cell);
          success = !error;
        };
        if (manim) {
          await this.withManimProgress(cell, "渲染", run);
        } else {
          await run();
        }
      } catch (error) {
        const value = error instanceof Error ? error : new Error(String(error));
        await execution.replaceOutput([
          new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(value)]),
        ], cell);
      } finally {
        execution.end(success, Date.now());
      }
    }
  }

  private async withManimProgress<T>(
    cell: vscode.NotebookCell,
    operationLabel: string,
    task: (
      report: ManimProgressReporter,
      token: vscode.CancellationToken,
    ) => Thenable<T>,
    initial: { state: ManimCellRunState; message: string } = {
      state: "preparing",
      message: "正在准备环境…",
    },
    location: vscode.ProgressLocation.Window | vscode.ProgressLocation.Notification =
      vscode.ProgressLocation.Notification,
  ): Promise<T> {
    const operation = ++this.progressOperation;
    const key = cell.document.uri.toString();
    return vscode.window.withProgress(
      {
        location,
        title: `Manim ${operationLabel} · Cell ${cell.index + 1}`,
        cancellable: location === vscode.ProgressLocation.Notification,
      },
      async (progress, token) => {
        const report: ManimProgressReporter = (state, message) => {
          let operations = this.cellProgressOperations.get(key);
          if (!operations) {
            operations = new Map();
            this.cellProgressOperations.set(key, operations);
          }
          operations.set(operation, state);
          this.publishCellRunState(cell, operations);
          progress.report({ message });
        };
        report(initial.state, initial.message);
        try {
          return await task(report, token);
        } finally {
          const operations = this.cellProgressOperations.get(key);
          operations?.delete(operation);
          if (operations?.size) {
            this.publishCellRunState(cell, operations);
          } else {
            this.cellProgressOperations.delete(key);
            this.cellRunStateChanged(cell, undefined);
          }
        }
      },
    );
  }

  private publishCellRunState(
    cell: vscode.NotebookCell,
    operations: ReadonlyMap<number, ManimCellRunState>,
  ): void {
    let latestOperation = -1;
    let latestState: ManimCellRunState | undefined;
    for (const [operation, state] of operations) {
      if (operation > latestOperation) {
        latestOperation = operation;
        latestState = state;
      }
    }
    this.cellRunStateChanged(cell, latestState);
  }

  private finalManimOutputs(outputs: KernelOutput[]): KernelOutput[] {
    const video = outputs.flatMap((output) => output.items)
      .find((output) => output.mime === MANIM_VIDEO_MIME);
    if (video) return [{ items: [video] }];
    const errors = outputs.filter((output) =>
      output.items.some((outputItem) => outputItem.mime === "application/vnd.code.notebook.error"));
    if (errors.length) return errors;
    throw new Error("Manim finished without producing a video.");
  }

  private sceneCommand(
    source: string,
    settings: ManimNotebookSettings,
    sceneClass: ManimSceneClass,
    interactive: boolean,
    outputOptions: ManimCellSettings = DEFAULT_CELL_SETTINGS,
    capturePartialMovies = false,
  ): { code: string; sceneName: string } {
    const bodySource = canonicalManimCellSource(source);
    if (!isManimCellSource(bodySource)) throw new Error("This Manim Cell does not define an object or animation.");
    const sceneName = sceneNameForBody(`${sceneClass}\n${bodySource}`);
    const body = bodySource.split(/\r?\n/).map((line) => line.trim() ? `        ${line}` : "").join("\n");
    // Judge animation presence per fragment (split at next_slide boundaries)
    // instead of on the whole merged source, so a pure-object Cell keeps its
    // autoShow + hold even when a later Cell in the same Scene animates it.
    const firstFragment = bodySource.split(/\r?\nself\.next_slide\s*\(/)[0];
    const hasAnimations = /\bself\.(?:play|wait)\s*\(/.test(firstFragment);
    const hasSceneOperations = /\bself\.(?:play|wait|add|remove)\s*\(/.test(firstFragment);
    // Pure definition cells never call self.add(...); surface every Mobject the
    // user created so the still frame shows the objects instead of an empty
    // scene. Cells that already call self.add/self.remove keep full control.
    const autoShow = hasSceneOperations ? "" : `
        _manim_jupyter_seen = set()
        for _manim_jupyter_value in list(locals().values()):
            if isinstance(_manim_jupyter_value, Mobject) and id(_manim_jupyter_value) not in _manim_jupyter_seen:
                _manim_jupyter_seen.add(id(_manim_jupyter_value))
                if _manim_jupyter_value not in self.mobjects:
                    self.add(_manim_jupyter_value)`;
    // Manim Slides refuses a page with zero animations (start == end). A
    // one-frame MP4 also reports 0:00 in Chromium and may display before its
    // first frame is decoded. Hold the scene for one second so pure-object
    // Cells produce a real, visible, autoplayable video and a valid slide
    // without clearing anything.
    const holdFrame = hasAnimations ? "" : `
        # A one-frame MP4 reports 0:00 in Chromium and may display before its
        # first frame is decoded. Hold a pure-object scene for one second so
        # the Cell output is a real, visible, autoplayable video.
        self.wait(1.0)`;
    const args = buildMagicArguments(sceneName, settings);
    const slideBehavior = interactive
      ? `    skip_reversing = False

    def _manim_jupyter_set_cell_options(self, options, replace_open_slide=True):
        global _MANIM_JUPYTER_ACTIVE_CELL_SETTINGS
        self._manim_jupyter_active_options = options
        _MANIM_JUPYTER_ACTIVE_CELL_SETTINGS = options
        if replace_open_slide:
            self._base_slide_config = _ManimJupyterBaseSlideConfig(
                loop=bool(options.get("loop", False)),
                auto_next=bool(options.get("autoplay", False)),
                playback_rate=float(options.get("playbackRate", 1.0)),
            )

    def next_slide(self, *args, **kwargs):
        _manim_jupyter_options = getattr(self, "_manim_jupyter_active_options", {})
        kwargs.setdefault("loop", bool(_manim_jupyter_options.get("loop", False)))
        kwargs.setdefault("auto_next", bool(_manim_jupyter_options.get("autoplay", False)))
        kwargs.setdefault("playback_rate", float(_manim_jupyter_options.get("playbackRate", 1.0)))
        return super().next_slide(*args, **kwargs)
`
      : `    # Cell output and PPTX export are one segment; interactive
    # navigation is generated separately by renderPresentation().
    skip_reversing = True

    def _manim_jupyter_set_cell_options(self, options, replace_open_slide=True):
        global _MANIM_JUPYTER_ACTIVE_CELL_SETTINGS
        self._manim_jupyter_active_options = options
        _MANIM_JUPYTER_ACTIVE_CELL_SETTINGS = options
`;
    const disableSlideBreaks = interactive
      ? ""
      : "        self.next_slide = lambda *args, **kwargs: None\n";
    const captureRender = capturePartialMovies
      ? `    def render(self, *args, **kwargs):
        global _MANIM_JUPYTER_PPTX_PARTIALS, _MANIM_JUPYTER_PPTX_RESOLUTION
        _manim_jupyter_old_max_files = config["max_files_cached"]
        config["max_files_cached"] = float("inf")
        _MANIM_JUPYTER_PPTX_PARTIALS = []
        _manim_jupyter_original_play = self.play

        def _manim_jupyter_capture_play(*play_args, **play_kwargs):
            global _MANIM_JUPYTER_PPTX_CAPTURE_TAIL
            # 一个真实的 self.play(...) 对应一页 PPTX:先渲染,再把新增的
            # partial movie 记入页面。wait(...) 内部也是 play(Wait),跳过,
            # 所以纯停顿不会单独占页。
            _manim_jupyter_before = list(self._partial_movie_files)
            _manim_jupyter_is_wait = len(play_args) == 1 and isinstance(play_args[0], Wait)
            _manim_jupyter_old_capture_tail = _MANIM_JUPYTER_PPTX_CAPTURE_TAIL
            _MANIM_JUPYTER_PPTX_CAPTURE_TAIL = not _manim_jupyter_is_wait
            try:
                _manim_jupyter_result = _manim_jupyter_original_play(*play_args, **play_kwargs)
            finally:
                _MANIM_JUPYTER_PPTX_CAPTURE_TAIL = _manim_jupyter_old_capture_tail
            _manim_jupyter_new_partials = self._partial_movie_files[len(_manim_jupyter_before):]
            if _manim_jupyter_is_wait:
                return _manim_jupyter_result
            for _manim_jupyter_value in _manim_jupyter_new_partials:
                if _manim_jupyter_value is None:
                    continue
                _manim_jupyter_candidate = _ManimJupyterPath(_manim_jupyter_value)
                if _manim_jupyter_candidate.is_file():
                    _MANIM_JUPYTER_PPTX_PARTIALS.append(str(_manim_jupyter_candidate))
            return _manim_jupyter_result

        self.play = _manim_jupyter_capture_play
        try:
            _ManimJupyterManimScene.render(self, *args, **kwargs)
        finally:
            config["max_files_cached"] = _manim_jupyter_old_max_files
        _MANIM_JUPYTER_PPTX_RESOLUTION = (
            int(config["pixel_width"]),
            int(config["pixel_height"]),
        )
`
      : "";
    const code = `# <manim-jupyter-wrapped>
_MANIM_JUPYTER_CELL_SETTINGS[${JSON.stringify(sceneName)}] = _manim_jupyter_json.loads(${JSON.stringify(JSON.stringify(outputOptions))})
_MANIM_JUPYTER_ACTIVE_CELL_SETTINGS = _manim_jupyter_json.loads(${JSON.stringify(JSON.stringify(outputOptions))})
_MANIM_JUPYTER_PPTX_PARTIALS = []
_MANIM_JUPYTER_PPTX_RESOLUTION = None
class ${sceneName}(${sceneClass}):
${slideBehavior}
${captureRender}

    def construct(self):
        _manim_jupyter_options = _MANIM_JUPYTER_CELL_SETTINGS.get(${JSON.stringify(sceneName)}, {})
        self._base_slide_config = _ManimJupyterBaseSlideConfig(
            loop=bool(_manim_jupyter_options.get("loop", False)),
            auto_next=bool(_manim_jupyter_options.get("autoplay", False)),
            playback_rate=float(_manim_jupyter_options.get("playbackRate", 1.0)),
        )
${disableSlideBreaks}${body}${autoShow}${holdFrame}

get_ipython().run_line_magic("manim", ${JSON.stringify(args)})
_MANIM_JUPYTER_CELL_SETTINGS.pop(${JSON.stringify(sceneName)}, None)
globals().pop(${JSON.stringify(sceneName)}, None)`;
    return { code, sceneName };
  }

  private wholeCellCommand(
    source: string,
    settings: ManimNotebookSettings,
    sceneClass: ManimSceneClass,
    outputOptions: ManimCellSettings = DEFAULT_CELL_SETTINGS,
  ): string {
    return this.sceneCommand(source, settings, sceneClass, false, outputOptions).code;
  }

  private manimFragmentsThrough(
    cell: vscode.NotebookCell,
    currentSource = cell.document.getText(),
  ): ManimCellFragment[] {
    const fragments = cell.notebook.getCells(new vscode.NotebookRange(0, cell.index + 1))
      .filter((candidate) => isManimCellMetadata(candidate.metadata))
      .map((candidate) => ({
        source: candidate.index === cell.index ? currentSource : candidate.document.getText(),
        settings: readManimCellSettings(candidate.metadata),
        sceneClass: readManimCellSceneClass(candidate.metadata),
      }));
    return groupManimSceneSegments(fragments).at(-1)?.fragments ?? [];
  }

  private notebookManimFragments(notebook: vscode.NotebookDocument): ManimCellFragment[] {
    return notebook.getCells()
      .filter((cell) => isManimCellMetadata(cell.metadata))
      .map((cell) => ({
        source: cell.document.getText(),
        settings: readManimCellSettings(cell.metadata),
        sceneClass: readManimCellSceneClass(cell.metadata),
      }));
  }

  private async executeCode(
    notebook: vscode.NotebookDocument,
    code: string,
    storeHistory = false,
    onProgress?: ManimRenderProgressListener,
    token?: vscode.CancellationToken,
  ): Promise<KernelOutput[]> {
    const worker = await this.selectedWorker(notebook);
    if (!worker) throw new Error("Select a Python environment from the notebook kernel picker first.");
    if (token?.isCancellationRequested) throw new Error("已取消 Manim 渲染。");
    const cancellation = token?.onCancellationRequested(() => worker.interrupt());
    try {
      return workerOutputs(await worker.execute(
        code.replace(/\r\n/g, "\n"),
        storeHistory,
        onProgress,
      ));
    } finally {
      cancellation?.dispose();
    }
  }

  async ensureRuntime(
    notebook: vscode.NotebookDocument,
    settings: ManimNotebookSettings,
    cellSettings: Record<string, ManimCellSettings>,
  ): Promise<boolean> {
    const key = notebook.uri.toString();
    const current = this.initializing.get(key);
    if (current) return current;
    const task = (async () => {
      const worker = await this.selectedWorker(notebook);
      if (!worker) return false;
      if (this.readyWorkers.has(worker as object)) return true;
      const outputs = await this.executeCode(notebook, this.startupCommand(settings, cellSettings));
      const error = outputs.flatMap((output) => output.items)
        .find((output) => output.mime === "application/vnd.code.notebook.error");
      if (error) throw outputError(error);
      this.readyWorkers.add(worker as object);
      return true;
    })().finally(() => this.initializing.delete(key));
    this.initializing.set(key, task);
    return task;
  }

  async syncRuntime(
    notebook: vscode.NotebookDocument,
    settings: ManimNotebookSettings,
    cellSettings: Record<string, ManimCellSettings>,
  ): Promise<boolean> {
    if (!await this.ensureRuntime(notebook, settings, cellSettings)) return false;
    const code = `# <manim-jupyter-wrapped>
import json as _manim_jupyter_json
_MANIM_JUPYTER_CELL_SETTINGS = _manim_jupyter_json.loads(${JSON.stringify(JSON.stringify(cellSettings))})
_MANIM_JUPYTER_ACTIVE_CELL_SETTINGS = {}
_MANIM_JUPYTER_MAGIC_ARGS = ${JSON.stringify(buildMagicArguments("{scene}", settings))}
MANIM_THEME = ${JSON.stringify(settings.theme)}
MANIM_FOREGROUND = ${JSON.stringify(settings.foregroundColor)}
config.media_width = ${JSON.stringify(settings.mediaWidth)}
config.media_embed = False
config.progress_bar = "none"
config.background_color = ${JSON.stringify(settings.backgroundColor)}
config.frame_width = config.frame_height * ${this.aspect(settings.aspectRatio)}
_MANIM_JUPYTER_BOOTSTRAP["videoLoop"] = ${JSON.stringify(settings.videoLoop)}`;
    const outputs = await this.executeCode(notebook, code);
    const error = outputs.flatMap((output) => output.items)
      .find((output) => output.mime === "application/vnd.code.notebook.error");
    if (error) throw outputError(error);
    return true;
  }

  async executeRaw(notebook: vscode.NotebookDocument, code: string): Promise<KernelOutput[]> {
    if (!await this.ensureRuntime(notebook, this.settingsProvider(), this.cellSettingsProvider(notebook))) {
      throw new Error("Select a Python environment from the notebook kernel picker first.");
    }
    const outputs = await this.executeCode(notebook, `# <manim-jupyter-wrapped>\n${code}`);
    const error = outputs.flatMap((output) => output.items)
      .find((item) => item.mime === "application/vnd.code.notebook.error");
    if (error) throw outputError(error);
    return outputs;
  }

  async exportPowerPoint(
    notebook: vscode.NotebookDocument,
    destination: string,
    token?: vscode.CancellationToken,
    onProgress?: ManimRenderProgressListener,
  ): Promise<void> {
    const settings = this.settingsProvider();
    if (!await this.ensureRuntime(notebook, settings, this.cellSettingsProvider(notebook))) {
      throw new Error("请先从 Notebook 右上角选择 Python 环境。");
    }
    const segments = groupManimSceneSegments(this.notebookManimFragments(notebook));
    if (!segments.length) throw new Error("没有可导出的 Manim Cell。");
    const commands = segments.map((segment) => this.sceneCommand(
      combineManimCellSources(segment.fragments, false),
      settings,
      segment.sceneClass,
      false,
      segment.fragments[0]?.settings,
      true,
    ));
    const renderedSegments = commands.map((command) => `${command.code}
_MANIM_JUPYTER_PPTX_ALL_PARTIALS.extend(_MANIM_JUPYTER_PPTX_PARTIALS)`).join("\n");
    const code = `# <manim-jupyter-wrapped>
_MANIM_JUPYTER_PPTX_ALL_PARTIALS = []
${renderedSegments}
if not _MANIM_JUPYTER_PPTX_ALL_PARTIALS:
    raise RuntimeError("没有可导出的 Manim 动画；请至少使用一次非 Wait 的 self.play(...)。")
_ManimJupyterBuildPptx(
    _MANIM_JUPYTER_PPTX_ALL_PARTIALS,
    ${JSON.stringify(destination)},
    loop=False,
)
del _MANIM_JUPYTER_PPTX_ALL_PARTIALS, _MANIM_JUPYTER_PPTX_PARTIALS, _MANIM_JUPYTER_PPTX_RESOLUTION`;
    const outputs = await this.executeCode(notebook, code, false, onProgress, token);
    const error = outputs.flatMap((output) => output.items)
      .find((item) => item.mime === "application/vnd.code.notebook.error");
    if (error) throw outputError(error);
    if (token?.isCancellationRequested) throw new Error("已取消 PowerPoint 导出。");
  }

  async replaceCellOutputs(cell: vscode.NotebookCell, outputs: readonly KernelOutput[]): Promise<void> {
    await this.registerControllers();
    const spec = this.selectedSpecs.get(cell.notebook.uri.toString());
    const controller = spec ? this.controllers.get(spec.id) : undefined;
    if (!controller) throw new Error("The selected Python environment is no longer available.");
    const execution = controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    try {
      await execution.replaceOutput(outputs.map(toNotebookOutput), cell);
      execution.end(true, Date.now());
    } catch (error) {
      execution.end(false, Date.now());
      throw error;
    }
  }

  private async validatePresentationScene(
    notebook: vscode.NotebookDocument,
    sceneName: string,
  ): Promise<void> {
    if (notebook.uri.scheme !== "file") {
      throw new Error("Manim Slides 需要先保存本地 *.manim.ipynb 文件。");
    }
    const configPath = path.join(path.dirname(notebook.uri.fsPath), "slides", `${sceneName}.json`);
    let parsed: { slides?: unknown };
    try {
      parsed = JSON.parse(await readFile(configPath, "utf8")) as { slides?: unknown };
    } catch (error) {
      throw new Error(
        `Manim Slides 没有为 ${sceneName} 生成有效配置：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed.slides) || !parsed.slides.length) {
      throw new Error(`${sceneName} 没有产生可放映的 slide；请至少使用一次 self.play(...) 或 self.wait(...)。`);
    }
  }

  private async convertToHtmlSlides(
    notebook: vscode.NotebookDocument,
    sceneNames: readonly string[],
    destination: string,
    folder: string,
    token?: vscode.CancellationToken,
    onProgress?: ManimRenderProgressListener,
  ): Promise<void> {
    // Match the Jupyter slides workflow used by upstream vscode-jupyter: render
    // through the already-selected private kernel, then let manim-slides' own
    // RevealJS exporter build the HTML deck. No `manim-slides present` (Qt)
    // subprocess is involved and no separate CLI interpreter is needed.
    const code = `# <manim-jupyter-wrapped>
from pathlib import Path as _ManimJupyterPath
from manim_slides.convert import RevealJS as _ManimJupyterRevealJS
from manim_slides.present import get_scenes_presentation_config as _ManimJupyterPresentationConfigs
_manim_jupyter_configs = _ManimJupyterPresentationConfigs(${JSON.stringify(sceneNames)}, _ManimJupyterPath(${JSON.stringify(folder)}))
_ManimJupyterRevealJS(
    presentation_configs=_manim_jupyter_configs,
    one_file=False,
    controls="true",
    progress="true",
    slide_number="c/t",
    hash="true",
    transition="none",
).convert_to(_ManimJupyterPath(${JSON.stringify(destination)}))
del _manim_jupyter_configs`;
    onProgress?.({
      stage: "converting",
      current: 0,
      total: 1,
      percent: 0,
      description: "正在生成 RevealJS HTML Slides…",
    });
    const outputs = await this.executeCode(notebook, code, false, onProgress, token);
    const error = outputs.flatMap((output) => output.items)
      .find((item) => item.mime === "application/vnd.code.notebook.error");
    if (error) throw outputError(error);
    onProgress?.({
      stage: "converting",
      current: 1,
      total: 1,
      percent: 100,
      description: "HTML Slides 已生成",
      done: true,
    });
  }

  async openHtmlPresentation(
    notebook: vscode.NotebookDocument,
    sceneNames: readonly string[],
    token?: vscode.CancellationToken,
    onProgress?: ManimRenderProgressListener,
  ): Promise<string> {
    if (!sceneNames.length) throw new Error("没有可放映的 Manim Scene。");
    if (!await this.ensureRuntime(notebook, this.settingsProvider(), this.cellSettingsProvider(notebook))) {
      throw new Error("请先从 Notebook 右上角选择 Python 环境。");
    }
    for (const sceneName of sceneNames) {
      await this.validatePresentationScene(notebook, sceneName);
    }
    const folder = path.join(path.dirname(notebook.uri.fsPath), "slides");
    const basename = path.basename(notebook.uri.fsPath)
      .replace(/\.manim\.ipynb$/i, "")
      .replace(/[^A-Za-z0-9_.-]+/g, "-") || "manim-presentation";
    const destination = path.join(folder, `${basename}.slides.html`);
    await this.convertToHtmlSlides(
      notebook,
      sceneNames,
      destination,
      folder,
      token,
      onProgress,
    );
    onProgress?.({ stage: "loading", description: "正在载入 HTML Slides…" });
    await vscode.workspace.fs.stat(vscode.Uri.file(destination));
    const html = repairRevealConfig(await readFile(destination, "utf8"));
    // Write the repaired presentation back so double-clicking the generated
    // .slides.html in a browser also works (manim-slides emits `slideNumber:
    // c/t` without quotes).
    try {
      await writeFile(destination, html, "utf8");
    } catch {
      // The in-memory copy used by the webview below is already repaired.
    }
    const extensionRoot = path.dirname(path.dirname(this.workerFile.fsPath));
    const revealRoot = path.join(extensionRoot, "renderer", "reveal");
    const panel = vscode.window.createWebviewPanel(
      "manimJupyter.slides",
      `${basename} · Manim Slides`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(folder),
          vscode.Uri.file(revealRoot),
        ],
      },
    );
    panel.webview.html = slidesWebviewHtml(
      panel.webview,
      html,
      destination,
      folder,
      revealRoot,
    );
    let slidesFullscreen = false;
    let slidesFullscreenToggle: Promise<void> = Promise.resolve();
    const setSlidesFullscreen = (enabled: boolean): void => {
      slidesFullscreenToggle = slidesFullscreenToggle.then(async () => {
        if (slidesFullscreen === enabled) return;
        try {
          await vscode.commands.executeCommand("workbench.action.toggleZenMode");
          slidesFullscreen = enabled;
        } catch {
          // The command can be unavailable in embedded extension hosts; leave
          // the webview in its current UI state instead of crashing playback.
        }
      });
    };
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const data = message as { type?: string };
      if (data.type === "openExternal") {
        void vscode.env.openExternal(vscode.Uri.file(destination));
      } else if (data.type === "enterFullscreen") {
        void setSlidesFullscreen(true);
      } else if (data.type === "exitFullscreen") {
        void setSlidesFullscreen(false);
      }
    });
    panel.onDidDispose(() => {
      void setSlidesFullscreen(false);
    });
    // Present the deck without the VS Code side bars from the moment it opens.
    void setSlidesFullscreen(true);
    return destination;
  }

  async renderWholeCell(cell: vscode.NotebookCell): Promise<KernelOutput[]> {
    return this.withManimProgress(cell, "渲染", async (report, token) => {
      const settings = this.settingsProvider();
      if (!await this.ensureRuntime(cell.notebook, settings, this.cellSettingsProvider(cell.notebook))) {
        throw new Error("Select a Python environment from the notebook kernel picker first.");
      }
      report("rendering", "正在渲染动画…");
      const cumulativeSource = combineManimCellSources(this.manimFragmentsThrough(cell), false);
      const outputs = await this.executeCode(
        cell.notebook,
        this.wholeCellCommand(
          cumulativeSource,
          settings,
          readManimCellSceneClass(cell.metadata),
          readManimCellSettings(cell.metadata),
        ),
        false,
        (value) => report("rendering", formatManimRenderProgress(value)),
        token,
      );
      const error = outputs.flatMap((output) => output.items)
        .find((item) => item.mime === "application/vnd.code.notebook.error");
      if (error) throw outputError(error);
      return this.finalManimOutputs(outputs);
    });
  }

  async renderPresentation(
    notebook: vscode.NotebookDocument,
    token?: vscode.CancellationToken,
    onProgress?: ManimRenderProgressListener,
  ): Promise<string[]> {
    const settings = this.settingsProvider();
    if (!await this.ensureRuntime(notebook, settings, this.cellSettingsProvider(notebook))) {
      throw new Error("请先从 Notebook 右上角选择 Python 环境。");
    }
    const segments = groupManimSceneSegments(this.notebookManimFragments(notebook));
    if (!segments.length) throw new Error("没有可放映的 Manim Cell。");
    const commands = segments.map((segment) => this.sceneCommand(
      combineManimCellSources(segment.fragments, true),
      settings,
      segment.sceneClass,
      true,
      segment.fragments[0]?.settings,
    ));
    const outputs = await this.executeCode(
      notebook,
      commands.map((command) => command.code).join("\n"),
      false,
      onProgress,
      token,
    );
    const error = outputs.flatMap((output) => output.items)
      .find((item) => item.mime === "application/vnd.code.notebook.error");
    if (error) throw outputError(error);
    for (const command of commands) {
      await this.validatePresentationScene(notebook, command.sceneName);
    }
    return commands.map((command) => command.sceneName);
  }

  async renderLine(
    cell: vscode.NotebookCell,
    cursorLine: number,
    settings: ManimNotebookSettings,
    cellSettings: ManimCellSettings,
    allCellSettings: Record<string, ManimCellSettings>,
  ): Promise<LinePreviewResult | undefined> {
    if (!cellSettings.linePreview) return undefined;
    const fragments = this.manimFragmentsThrough(cell).filter((fragment) => fragment.source.trim());
    if (!fragments.length) return undefined;
    // Runtime call-site matching uses the current Cell's original line numbers.
    const currentFragment = fragments[fragments.length - 1];
    const cellSource = currentFragment.source.replace(/\r\n/g, "\n");
    const preview = previewAtLine(cellSource, cursorLine);
    if (!preview || !await this.ensureRuntime(cell.notebook, settings, allCellSettings)) return undefined;
    this.linePreviewCancellation?.cancel();
    this.linePreviewCancellation?.dispose();
    const cancellation = new vscode.CancellationTokenSource();
    this.linePreviewCancellation = cancellation;
    const previewName = "_ManimLinePreview";
    const preceding = fragments.slice(0, -1);
    const precedingSource = combineManimCellSources(preceding, false);
    const currentSource = (preview.kind === "animation"
      ? cellSource
      : preview.sourceThroughStatement).replace(/\r\n/g, "\n");
    // The anchor is relative to the current Cell, not preceding Cells.
    const body = [
      ...(precedingSource ? [indentSourceLines(precedingSource, "        ")] : []),
      "        _manim_jupyter_cell_start = _manim_jupyter_inspect.currentframe().f_lineno + 1",
      indentSourceLines(currentSource, "        "),
    ].join("\n");
    const previewSettings = previewRenderSettings(settings);
    const args = buildMagicArguments(
      previewName,
      previewSettings,
      "l",
      undefined,
      preview.kind === "object",
    );
    const objectFinish = preview.kind === "object" && preview.objectName
      ? `
        _manim_preview_value = locals().get(${JSON.stringify(preview.objectName)})
        if isinstance(_manim_preview_value, Mobject) and _manim_preview_value not in self.mobjects:
            self.add(_manim_preview_value)
        self.wait(1 / max(float(config.frame_rate), 1))`
      : "";
    const sceneClass = readManimCellSceneClass(cell.metadata);
    const previewSceneClass = LINE_PREVIEW_SCENE_CLASSES[sceneClass];
    const code = `# <manim-jupyter-wrapped>
_MANIM_JUPYTER_ACTIVE_CELL_SETTINGS = _manim_jupyter_json.loads(${JSON.stringify(JSON.stringify(cellSettings))})
class ${previewName}(${previewSceneClass}):
    def construct(self):
        # Slide boundaries are irrelevant to line previews.
        self.next_slide = lambda *args, **kwargs: None
        # Select the cursor call through Manim's animation range.
        _manim_jupyter_original_play = self.play
        _manim_jupyter_original_wait = self.wait
        _manim_jupyter_preview_start = ${preview.line}
        _manim_jupyter_preview_end = ${preview.endLine}
        import inspect as _manim_jupyter_inspect
        from manim.utils.exceptions import EndSceneEarlyException as _ManimJupyterPreviewComplete
        _manim_jupyter_cell_start = None
        _manim_jupyter_preview_filename = _manim_jupyter_inspect.currentframe().f_code.co_filename
        _manim_jupyter_target_selected = False
        config["from_animation_number"] = 10 ** 12
        config["upto_animation_number"] = -1
        def _manim_jupyter_select_current_animation():
            nonlocal _manim_jupyter_target_selected
            if _manim_jupyter_target_selected:
                return False
            _manim_jupyter_number = self.renderer.num_plays
            config["from_animation_number"] = _manim_jupyter_number
            config["upto_animation_number"] = _manim_jupyter_number
            _manim_jupyter_target_selected = True
            return True
        def _manim_jupyter_is_cursor_call():
            if _manim_jupyter_cell_start is None:
                return False
            # Include animations invoked through helper calls.
            _manim_jupyter_frame = _manim_jupyter_inspect.currentframe().f_back
            while _manim_jupyter_frame is not None:
                if _manim_jupyter_frame.f_code.co_filename == _manim_jupyter_preview_filename:
                    _manim_jupyter_line = _manim_jupyter_frame.f_lineno - _manim_jupyter_cell_start
                    if _manim_jupyter_preview_start <= _manim_jupyter_line <= _manim_jupyter_preview_end:
                        return True
                _manim_jupyter_frame = _manim_jupyter_frame.f_back
            return False
        def _manim_jupyter_guarded_play(*args, **kwargs):
            _manim_jupyter_target = (
                _manim_jupyter_is_cursor_call()
                and _manim_jupyter_select_current_animation()
            )
            _manim_jupyter_result = _manim_jupyter_original_play(*args, **kwargs)
            if _manim_jupyter_target:
                raise _ManimJupyterPreviewComplete()
            return _manim_jupyter_result
        def _manim_jupyter_guarded_wait(*args, **kwargs):
            _manim_jupyter_target = (
                _manim_jupyter_is_cursor_call()
                and _manim_jupyter_select_current_animation()
            )
            _manim_jupyter_result = _manim_jupyter_original_wait(*args, **kwargs)
            if _manim_jupyter_target:
                raise _ManimJupyterPreviewComplete()
            return _manim_jupyter_result
        self.play = _manim_jupyter_guarded_play
        self.wait = _manim_jupyter_guarded_wait
${body}${objectFinish}

get_ipython().run_line_magic("manim", ${JSON.stringify(args)})
globals().pop(${JSON.stringify(previewName)}, None)`;
    try {
      if (cancellation.token.isCancellationRequested) return undefined;
      const outputs = await this.withManimProgress(
        cell,
        "预览",
        async (report, token) => this.executeCode(
          cell.notebook,
          code,
          false,
          (value) => report("rendering", formatManimRenderProgress(value)),
          token,
        ),
        { state: "rendering", message: "正在渲染光标所在动画…" },
        vscode.ProgressLocation.Window,
      );
      if (cancellation.token.isCancellationRequested) return undefined;
      return {
        outputs,
        statement: preview.text,
        kind: preview.kind,
        animationIndex: preview.animationIndex,
        objectName: preview.objectName,
      };
    } finally {
      if (this.linePreviewCancellation === cancellation) this.linePreviewCancellation = undefined;
      cancellation.dispose();
    }
  }

  startupCommand(settings: ManimNotebookSettings, cellSettings: Record<string, ManimCellSettings>): string {
    const payload = JSON.stringify({
      cellSettings,
      magicArgs: buildMagicArguments("{scene}", settings),
      theme: settings.theme,
      foregroundColor: settings.foregroundColor,
      mediaWidth: settings.mediaWidth,
      backgroundColor: settings.backgroundColor,
      aspect: this.aspect(settings.aspectRatio),
      videoLoop: settings.videoLoop,
    });
    const file = this.startupFile.fsPath;
    return `# <manim-jupyter-wrapped>
import json as _manim_jupyter_json
_MANIM_JUPYTER_BOOTSTRAP = _manim_jupyter_json.loads(${JSON.stringify(payload)})
exec(compile(open(${JSON.stringify(file)}, encoding="utf-8").read(), ${JSON.stringify(file)}, "exec"))`;
  }

  private aspect(value: ManimNotebookSettings["aspectRatio"]): number {
    return value === "4:3" ? 4 / 3 : value === "1:1" ? 1 : value === "9:16" ? 9 / 16 : 16 / 9;
  }
}
