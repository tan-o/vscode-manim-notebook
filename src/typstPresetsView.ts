import * as vscode from "vscode";
import { TYPST_MATH_COMPLETIONS, TypstMathCompletion } from "./typstMath";

interface CharacterGroup {
  title: string;
  wide?: boolean;
  entries: TypstMathCompletion[];
}

const byLabel = new Map(
  TYPST_MATH_COMPLETIONS.map((item) => [item.label, item] as const),
);

function pick(labels: readonly string[]): TypstMathCompletion[] {
  return labels.flatMap((label) => {
    const item = byLabel.get(label);
    return item ? [item] : [];
  });
}

const groups: CharacterGroup[] = [
  {
    title: "希腊字母 · 小写",
    entries: pick([
      "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
      "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi",
      "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
    ]),
  },
  {
    title: "希腊字母 · 大写",
    entries: pick([
      "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
      "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi",
      "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega",
    ]),
  },
  {
    title: "希腊变体",
    entries: pick(["epsilon.alt", "theta.alt", "pi.alt", "rho.alt", "phi.alt"]),
  },
  {
    title: "运算符",
    entries: pick([
      "integral", "integral.double", "integral.triple", "integral.cont",
      "sum", "product", "partial", "nabla", "sqrt", "infinity",
      "plus.minus", "minus.plus", "times", "dot", "dot.op", "Delta",
    ]),
  },
  {
    title: "关系与集合",
    entries: pick([
      "eq.not", "approx", "equiv", "lt.eq", "gt.eq", "in", "in.not",
      "subset", "subset.eq", "supset", "supset.eq", "parallel", "perp",
      "emptyset", "union", "inter", "and", "or", "not", "forall", "exists",
      "NN", "ZZ", "QQ", "RR", "CC",
    ]),
  },
  {
    title: "箭头",
    entries: pick([
      "arrow.l", "arrow.r", "arrow.l.r", "arrow.t", "arrow.b",
      "arrow.l.double", "arrow.r.double", "arrow.l.r.double", "arrow.long.r",
    ]),
  },
  {
    title: "Typst 结构模板",
    wide: true,
    entries: pick([
      "integral.bounds", "sum.bounds", "product.bounds", "frac", "sqrt",
      "root", "lim", "cases", "mat", "vec", "binom", "abs", "norm",
    ]),
  },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class TypstPresetsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "manimJupyter.typstPresets";

  constructor(private readonly insert: (value: string) => Promise<void>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const data = message as { type?: string; value?: string };
      if (data.type === "insert" && typeof data.value === "string") {
        await this.insert(data.value);
      }
    });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const sections = groups
      .map(
        (group) => `<section>
          <h3>${escapeHtml(group.title)}</h3>
          <div class="grid${group.wide ? " wide" : ""}">
            ${group.entries
              .map((entry) => {
                const label = entry.snippet
                  ? entry.insertText.replace(/\$\{\d+:([^}]+)\}/g, "$1")
                  : entry.label;
                const display = group.wide
                  ? `${entry.glyph} ${escapeHtml(entry.label)}`
                  : escapeHtml(entry.glyph);
                return `<button type="button" title="${escapeHtml(`${entry.label} · ${entry.detail} → ${label}`)}" data-value="${escapeHtml(entry.insertText)}">${display}</button>`;
              })
              .join("")}
          </div>
        </section>`,
      )
      .join("");
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 4px 10px 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    section { margin: 8px 0 12px; }
    h3 { margin: 0 0 6px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 3px; }
    button { min-width: 0; height: 30px; padding: 0 3px; border: 1px solid var(--vscode-panel-border); border-radius: 2px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 17px var(--vscode-editor-font-family); cursor: pointer; }
    button:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .wide { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); }
    .wide button { height: auto; min-height: 30px; padding: 4px 4px; font: 11px/1.25 var(--vscode-font-family); }
  </style>
</head>
<body>
  ${sections}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-value]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({type:'insert', value:button.dataset.value});
    }));
  </script>
</body>
</html>`;
  }
}
