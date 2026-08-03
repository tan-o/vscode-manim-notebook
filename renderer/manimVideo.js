const pending = new Map();
const objectUrls = new Map();
let nextId = 0;

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && value.type === "Buffer" && Array.isArray(value.data)) {
    return new Uint8Array(value.data);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  return undefined;
}

function base64Bytes(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const binary = atob(value);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      result[index] = binary.charCodeAt(index);
    }
    return result;
  } catch {
    return undefined;
  }
}

function isSupportedVideoHeader(chunks, mimeType) {
  const first = chunks[0];
  if (!first || first.byteLength < 12) return false;
  if (mimeType === "video/webm") {
    return first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3;
  }
  return String.fromCharCode(first[4], first[5], first[6], first[7]) === "ftyp";
}

function fail(state, message) {
  state.chunks = [];
  state.video.pause();
  state.video.removeAttribute("src");
  state.video.style.display = "none";
  state.status.textContent = message;
  state.status.className = "manim-video-error";
  state.status.style.color = "var(--vscode-errorForeground)";
  state.status.style.whiteSpace = "pre-wrap";
  if (!state.status.isConnected) state.element.appendChild(state.status);
  const url = objectUrls.get(state.outputId);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(state.outputId);
  }
  pending.delete(state.requestId);
}

export function activate(context) {
  context.onDidReceiveMessage?.((message) => {
    const state = message?.id ? pending.get(message.id) : undefined;
    if (!state) return;
    if (message.type === "videoStart") {
      state.chunks = [];
      state.received = 0;
      state.size = Number(message.size) || 0;
      state.status.textContent = "正在载入 Manim 视频…";
      return;
    }
    if (message.type === "videoChunk") {
      // chunkBase64 is the canonical protocol. Keep the older decoder here
      // only for VS Code builds that really do preserve typed arrays.
      const chunk = base64Bytes(message.chunkBase64) || bytes(message.chunk);
      if (!chunk || chunk.byteLength === 0) {
        fail(state, "视频传输失败：VS Code Renderer 没有收到有效二进制数据。请重新运行当前 Cell。");
        return;
      }
      if (state.received + chunk.byteLength > state.size) {
        fail(state, "视频传输失败：收到的数据超过 Manim 视频文件大小。");
        return;
      }
      state.chunks.push(chunk);
      state.received += chunk.byteLength;
      if (state.size > 0) {
        state.status.textContent = `正在载入 Manim 视频… ${Math.min(100, Math.round(state.received * 100 / state.size))}%`;
      }
      return;
    }
    if (message.type === "videoEnd") {
      if (state.received !== state.size || Number(message.received) !== state.size) {
        fail(state, `视频传输不完整：应为 ${state.size} 字节，实际收到 ${state.received} 字节。`);
        return;
      }
      if (!isSupportedVideoHeader(state.chunks, state.payload.mimeType || "video/mp4")) {
        fail(state, "Manim 输出不是有效的 MP4/WebM 文件，已停止加载。");
        return;
      }
      const blob = new Blob(state.chunks, { type: state.payload.mimeType || "video/mp4" });
      state.chunks = [];
      const url = URL.createObjectURL(blob);
      const previousUrl = objectUrls.get(state.outputId);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      objectUrls.set(state.outputId, url);
      state.video.src = url;
      state.status.textContent = "正在读取视频元数据…";
      const timeout = setTimeout(() => {
        if (pending.has(message.id)) fail(state, "视频文件已载入，但 VS Code 未能读取其时长或编码信息。");
      }, 15000);
      state.video.addEventListener("loadedmetadata", () => {
        clearTimeout(timeout);
        if (!Number.isFinite(state.video.duration) || state.video.duration <= 0) {
          fail(state, "视频文件没有有效时长。请检查 FFmpeg 编码器输出。");
          return;
        }
        state.video.playbackRate = Number(state.payload.playbackRate) || 1;
        state.video.style.display = "block";
        state.status.remove();
        pending.delete(message.id);
        void state.video.play().catch(() => undefined);
      }, { once: true });
      state.video.addEventListener("error", () => {
        clearTimeout(timeout);
        const code = state.video.error?.code;
        fail(state, `VS Code 无法解码 Manim 视频${code ? `（媒体错误 ${code}）` : ""}。`);
      }, { once: true });
      state.video.load();
      return;
    }
    if (message.type === "videoError") {
      fail(state, message.message || "Manim 视频载入失败。");
    }
  });

  return {
    renderOutputItem(outputItem, element) {
      const payload = outputItem.json();
      if (payload?.kind === "progress") {
        const wrapper = document.createElement("div");
        wrapper.style.padding = "8px 0 10px";
        const label = document.createElement("div");
        label.textContent = payload.message || "Rendering Manim…";
        label.style.marginBottom = "6px";
        label.style.color = "var(--vscode-descriptionForeground)";
        const track = document.createElement("div");
        track.setAttribute("role", "progressbar");
        track.style.height = "2px";
        track.style.overflow = "hidden";
        track.style.background = "var(--vscode-progressBar-background)";
        track.style.opacity = "0.28";
        const bar = document.createElement("div");
        bar.style.width = `${Math.max(4, Math.min(100, Number(payload.percent) || 32))}%`;
        bar.style.height = "100%";
        bar.style.background = "var(--vscode-progressBar-background)";
        bar.style.opacity = "1";
        track.appendChild(bar);
        wrapper.append(label, track);
        element.replaceChildren(wrapper);
        return;
      }
      const id = `manim-video-${Date.now().toString(36)}-${nextId++}`;
      const video = document.createElement("video");
      video.style.maxWidth = "100%";
      video.style.width = /^(?:\d+(?:\.\d+)?)(?:%|px|rem|em|vw)$/.test(String(payload.width || ""))
        ? String(payload.width)
        : "100%";
      video.style.display = "none";
      video.autoplay = true;
      video.loop = Boolean(payload.loop);
      video.controls = payload.controls !== false;
      video.muted = true;
      video.defaultMuted = true;
      video.setAttribute("muted", "");
      video.playsInline = true;
      video.preload = "auto";
      const status = document.createElement("div");
      status.textContent = "正在载入 Manim 视频…";
      status.style.padding = "8px 0";
      element.replaceChildren(video, status);
      pending.set(id, {
        requestId: id,
        outputId: outputItem.id,
        element,
        payload,
        video,
        status,
        chunks: [],
        received: 0,
        size: 0,
      });
      context.postMessage?.({ type: "loadVideo", id, path: payload.path });
    },
    disposeOutputItem(id) {
      for (const [requestId, state] of pending) {
        if (state.outputId === id) {
          context.postMessage?.({ type: "cancelVideo", id: requestId });
          state.chunks = [];
          pending.delete(requestId);
        }
      }
      const url = objectUrls.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.delete(id);
      }
    },
  };
}
