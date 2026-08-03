import { open, stat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export const MANIM_VIDEO_RENDERER_ID = "manimJupyter.video-renderer";

interface LoadVideoMessage {
  type?: string;
  id?: string;
  path?: string;
}

const CHUNK_BYTES = 512 * 1024;
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class ManimVideoRendererService implements vscode.Disposable {
  private readonly messaging = vscode.notebooks.createRendererMessaging(
    MANIM_VIDEO_RENDERER_ID,
  );
  private readonly subscription: vscode.Disposable;
  private queue: Promise<void> = Promise.resolve();
  private readonly requests = new Set<string>();
  private readonly cancelled = new Set<string>();
  private disposed = false;

  constructor() {
    this.subscription = this.messaging.onDidReceiveMessage((event) => {
      const message = event.message as LoadVideoMessage;
      if (message.type === "cancelVideo" && message.id) {
        if (this.requests.has(message.id)) this.cancelled.add(message.id);
        return;
      }
      if (message.type !== "loadVideo" || !message.id || !message.path) {
        return;
      }
      this.cancelled.delete(message.id);
      this.requests.add(message.id);
      this.queue = this.queue
        .then(() => this.stream(event.editor, message.id!, message.path!))
        .catch(async (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          await this.messaging.postMessage(
            { type: "videoError", id: message.id, message: detail },
            event.editor,
          );
        })
        .finally(() => {
          this.requests.delete(message.id!);
          this.cancelled.delete(message.id!);
        });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
  }

  private allowed(editor: vscode.NotebookEditor, filename: string): string {
    const resolved = path.resolve(filename);
    const extension = path.extname(resolved).toLowerCase();
    if (![".mp4", ".webm", ".mov", ".m4v"].includes(extension)) {
      throw new Error("拒绝读取非视频文件。 ");
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (editor.notebook.uri.scheme === "file") {
      roots.push(path.dirname(editor.notebook.uri.fsPath));
    }
    if (!roots.some((root) => inside(root, resolved))) {
      throw new Error("视频不在当前 Notebook 或工作区目录中。 ");
    }
    return resolved;
  }

  private async stream(
    editor: vscode.NotebookEditor,
    id: string,
    filename: string,
  ): Promise<void> {
    if (this.disposed) return;
    const resolved = this.allowed(editor, filename);
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error("Manim 视频文件不存在。 ");
    }
    if (info.size > MAX_VIDEO_BYTES) {
      throw new Error("视频超过 128 MiB；请降低质量或缩短当前 Cell，避免 VS Code 内存不足。 ");
    }
    if (info.size < 16) {
      throw new Error("Manim 生成的视频为空或不完整。 ");
    }
    if (this.cancelled.delete(id)) return;
    const started = await this.messaging.postMessage(
      { type: "videoStart", id, size: info.size },
      editor,
    );
    if (!started) return;
    const handle = await open(resolved, "r");
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      while (position < info.size && !this.disposed && !this.cancelled.has(id)) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(CHUNK_BYTES, info.size - position),
          position,
        );
        if (!bytesRead) break;
        // Renderer messaging is JSON-serialized by some VS Code builds. In
        // those builds both Buffer and ArrayBuffer arrive as empty objects.
        // Base64 keeps every chunk portable while retaining the bounded,
        // streaming memory profile (the complete video is never base64'd at
        // once and the notebook still stores only the file descriptor).
        const chunkBase64 = buffer.subarray(0, bytesRead).toString("base64");
        const delivered = await this.messaging.postMessage(
          { type: "videoChunk", id, chunkBase64 },
          editor,
        );
        if (!delivered) break;
        position += bytesRead;
      }
      if (!this.disposed && !this.cancelled.delete(id)) {
        await this.messaging.postMessage(
          { type: "videoEnd", id, received: position },
          editor,
        );
      }
    } finally {
      await handle.close();
    }
  }
}
