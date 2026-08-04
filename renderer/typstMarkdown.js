// Native Typst math for notebook Markdown cells.
//
// VS Code renders notebook Markdown with the built-in
// `vscode.markdown-it-renderer`: one shared markdown-it instance, output
// inserted into each cell's shadow DOM, and cell metadata available as
// `env.outputItem.metadata`. This renderer follows exactly that mechanism
// (the same pattern as the built-in math extension):
//   * rules are installed into the shared markdown-it instance;
//   * `$...$` / `$$...$$` is claimed only for cells whose metadata carries
//     `manimJupyterTypst` (our *.manim.ipynb markup cells), so ordinary
//     notebooks keep the default math renderer untouched;
//   * placeholders are resolved by observing each cell's shadow root (a plain
//     `document.body` observer cannot see inside shadow DOM);
//   * styles are shipped as `<template class="markdown-style">`, which the
//     built-in renderer clones into every Markdown shadow root.
//
// The formula itself is compiled to native MathML by the extension host
// (typst -> MathML); no SVG, no third-party math renderer.

const pending = new Map();
const observedShadowRoots = new Set();
let nextId = 0;
let mathmlCss = "";
const requestRetryMs = 250;
const safetyScanMs = 1500;

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapedAt(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * The built-in renderer passes the Markdown cell as `env.outputItem`; VS Code
 * puts the cell's metadata on that output item. Only cells carrying our
 * `manimJupyterTypst` flag opt into Typst math.
 */
function isTypstMathCell(env) {
  const metadata = env && env.outputItem ? env.outputItem.metadata : undefined;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (metadata.manimJupyterTypst === true) {
    return true;
  }
  const nested = metadata.metadata;
  return Boolean(
    nested && typeof nested === "object" && nested.manimJupyterTypst === true,
  );
}

function installTypstRules(md) {
  md.inline.ruler.before("escape", "manim_typst_inline", (state, silent) => {
    if (!isTypstMathCell(state.env)) {
      return false;
    }
    if (
      state.src[state.pos] !== "$" ||
      state.src[state.pos + 1] === "$" ||
      escapedAt(state.src, state.pos)
    ) {
      return false;
    }
    let end = state.pos + 1;
    while ((end = state.src.indexOf("$", end)) >= 0) {
      if (!escapedAt(state.src, end) && state.src[end + 1] !== "$") break;
      end += 1;
    }
    if (end < 0 || /\n/.test(state.src.slice(state.pos + 1, end))) {
      return false;
    }
    if (!silent) {
      const token = state.push("manim_typst_inline", "span", 0);
      token.content = state.src.slice(state.pos + 1, end).trim();
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.before("fence", "manim_typst_block", (state, start, end, silent) => {
    if (!isTypstMathCell(state.env)) {
      return false;
    }
    const first = state.getLines(start, start + 1, 0, false).trim();
    if (!first.startsWith("$$")) {
      return false;
    }
    let content = first.slice(2);
    let finish = start;
    if (content.endsWith("$$")) {
      content = content.slice(0, -2);
    } else {
      let found = false;
      for (finish = start + 1; finish < end; finish += 1) {
        const line = state.getLines(finish, finish + 1, 0, false);
        const marker = line.indexOf("$$");
        if (marker >= 0) {
          content += `\n${line.slice(0, marker)}`;
          found = true;
          break;
        }
        content += `\n${line}`;
      }
      if (!found) {
        return false;
      }
    }
    if (!silent) {
      const token = state.push("manim_typst_block", "div", 0);
      token.block = true;
      token.content = content.trim();
      token.map = [start, finish + 1];
    }
    state.line = finish + 1;
    return true;
  });

  const placeholder = (token, display) => {
    const expression = escapeHtml(token.content);
    return `<span class="manim-typst-host pending ${display ? "display" : "inline"}" role="math" aria-label="${expression}" data-expression="${encodeURIComponent(token.content)}"><span class="manim-typst-source">${expression}</span></span>`;
  };
  md.renderer.rules.manim_typst_inline = (tokens, index) => placeholder(tokens[index], false);
  md.renderer.rules.manim_typst_block = (tokens, index) => placeholder(tokens[index], true);

  const remapMathToken = (token) => {
    if (token.type === "math_inline") {
      token.type = "manim_typst_inline";
      token.tag = "span";
      token.block = false;
      return;
    }
    if (
      token.type === "math_inline_block" ||
      token.type === "math_inline_bare_block" ||
      token.type === "math_block"
    ) {
      token.type = "manim_typst_block";
      token.tag = "div";
      token.block = true;
    }
  };

  // The default math extension may tokenize `$...$` before this extension's
  // rules run. Take every math token over only inside Typst Markdown cells.
  md.core.ruler.after("inline", "manim_typst_takeover", (state) => {
    if (!isTypstMathCell(state.env)) {
      return;
    }
    for (const token of state.tokens) {
      remapMathToken(token);
      if (token.children) {
        for (const child of token.children) {
          remapMathToken(child);
        }
      }
    }
  });
}

function startRequest(context, element) {
  const id = `typst-${Date.now().toString(36)}-${nextId++}`;
  element.dataset.requested = "true";
  const message = {
    type: "renderTypst",
    id,
    expression: decodeURIComponent(element.dataset.expression || ""),
    display: element.classList.contains("display"),
  };
  pending.set(id, { element, message, attempts: 0, timer: undefined });
  sendRequest(context, id);
}

function sendRequest(context, id) {
  const entry = pending.get(id);
  if (!entry) {
    return;
  }
  if (entry.element.isConnected === false) {
    clearTimeout(entry.timer);
    pending.delete(id);
    return;
  }
  entry.attempts += 1;
  try {
    const delivery = context.postMessage(entry.message);
    Promise.resolve(delivery).catch(() => undefined);
  } catch {
    // The renderer can be ready before the extension host has attached its
    // message listener. The scheduled retry below closes that startup race.
  }
  entry.timer = setTimeout(() => sendRequest(context, id), requestRetryMs);
}

function pendingIn(root) {
  return Array.from(
    root.querySelectorAll(
      ".manim-typst-host:not([data-requested]):not([data-rendered]):not([data-error])",
    ),
  );
}

function requestPending(context, root) {
  if (root) {
    for (const element of pendingIn(root)) {
      startRequest(context, element);
    }
    return;
  }
  for (const element of document.querySelectorAll(
    ".manim-typst-host:not([data-requested]):not([data-rendered]):not([data-error])",
  )) {
    startRequest(context, element);
  }
  for (const shadowRoot of observedShadowRoots) {
    for (const element of pendingIn(shadowRoot)) {
      startRequest(context, element);
    }
  }
}

function collectShadowRoots() {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node.querySelectorAll !== "function") {
      return;
    }
    if (node.shadowRoot) {
      found.push(node.shadowRoot);
      walk(node.shadowRoot);
    }
    for (const child of node.childNodes || []) {
      walk(child);
    }
  };
  walk(document.body);
  return found;
}

let scanScheduled = false;
function scheduleScan(context) {
  if (scanScheduled) {
    return;
  }
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    observeShadowRoots(context);
    requestPending(context);
  }, 50);
}

function observeShadowRoots(context) {
  for (const shadowRoot of collectShadowRoots()) {
    if (observedShadowRoots.has(shadowRoot)) {
      continue;
    }
    observedShadowRoots.add(shadowRoot);
    // Placeholders land inside each cell's shadow DOM; a body-level observer
    // cannot see them, so every shadow root gets its own observer.
    new MutationObserver(() => requestPending(context, shadowRoot))
      .observe(shadowRoot, { childList: true, subtree: true, characterData: true });
  }
}

function applyMathmlCss() {
  if (!mathmlCss) {
    return;
  }
  const apply = (root) => {
    const doc = root.ownerDocument || root;
    let style = root.getElementById("manim-typst-mathml-css");
    if (!style) {
      style = doc.createElement("style");
      style.id = "manim-typst-mathml-css";
      (root.head || root).appendChild(style);
    }
    style.textContent = mathmlCss;
  };
  apply(document);
  for (const shadowRoot of observedShadowRoots) {
    apply(shadowRoot);
  }
}

function addStyles() {
  const css = `
    .manim-typst-host{color:inherit;box-sizing:border-box}
    .manim-typst-host.inline{display:inline;margin:0 .12em;max-width:100%}
    .manim-typst-host.inline math{font-size:1.06em;overflow-x:auto}
    .manim-typst-host.display{display:flex;justify-content:safe center;align-items:center;width:100%;margin:1.25em 0;padding:.35em 0;overflow-x:auto;overflow-y:hidden;container-type:inline-size}
    .manim-typst-host.display math{font-size:min(1.5em,5cqw)}
    .manim-typst-host.pending{min-height:1.15em}
    .manim-typst-source{font-family:var(--vscode-editor-font-family);font-size:.9em;opacity:.25}
    .manim-typst-error{display:inline-flex;align-items:center;gap:.35em;color:var(--vscode-errorForeground);font-family:var(--vscode-editor-font-family);white-space:pre-wrap}
  `;
  // The built-in renderer clones every `.markdown-style` template into each
  // Markdown cell's shadow DOM, exactly like the built-in math extension.
  const template = document.createElement("template");
  template.classList.add("markdown-style");
  const templateStyle = document.createElement("style");
  templateStyle.textContent = css;
  template.content.appendChild(templateStyle);
  document.head.appendChild(template);
  // Document-level copy as a safety net for render paths without a shadow root.
  const docStyle = document.createElement("style");
  docStyle.textContent = css;
  document.head.appendChild(docStyle);
}

export async function activate(context) {
  if (!context.postMessage || !context.onDidReceiveMessage) {
    return;
  }
  context.onDidReceiveMessage((message) => {
    if (message?.type !== "typstRendered" || !message.id) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(message.id);
    try {
      if (typeof message.css === "string" && message.css) {
        mathmlCss = message.css;
        try {
          applyMathmlCss();
        } catch {
          // The alignment CSS is cosmetic; never let it block the formula.
        }
      }
      if (message.mathml && /^<math\b/.test(message.mathml.trim())) {
        entry.element.classList.remove("pending");
        entry.element.setAttribute("data-rendered", "true");
        entry.element.innerHTML = message.mathml;
      } else {
        entry.element.classList.add("manim-typst-error");
        entry.element.setAttribute("data-error", "true");
        entry.element.title = message.error || "Typst 渲染失败";
        entry.element.textContent = `⚠ ${decodeURIComponent(entry.element.dataset.expression || "Typst 渲染失败")}`;
      }
    } finally {
      entry.element.removeAttribute("data-requested");
    }
  });

  const renderer = await context.getRenderer("vscode.markdown-it-renderer");
  if (!renderer) {
    throw new Error("Could not load vscode.markdown-it-renderer");
  }
  renderer.extendMarkdownIt((md) => installTypstRules(md));
  addStyles();

  // Markup cells are created in the light DOM (with a shadow root attached by
  // the built-in renderer), so a body observer catches new cells and then we
  // attach per-shadow-root observers for the placeholders.
  new MutationObserver(() => scheduleScan(context))
    .observe(document.body, { childList: true, subtree: true });
  observeShadowRoots(context);
  requestPending(context);

  // Safety net: re-scan in case a shadow root or placeholder appeared without
  // a mutation we could observe.
  setInterval(() => {
    observeShadowRoots(context);
    requestPending(context);
  }, safetyScanMs);
}
