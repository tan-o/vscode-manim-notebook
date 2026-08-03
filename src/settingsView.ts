import * as vscode from "vscode";
import { ManimNotebookSettings } from "./core";

const CONFIG_KEYS: Array<keyof ManimNotebookSettings> = [
  "quality",
  "renderer",
  "disableCaching",
  "mediaWidth",
  "theme",
  "backgroundColor",
  "foregroundColor",
  "pixelWidth",
  "aspectRatio",
  "frameRate",
];

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "manimJupyter.settings";
  private view: vscode.WebviewView | undefined;
  private writing = false;

  constructor(
    private readonly readSettings: () => ManimNotebookSettings,
    private readonly onDidUpdate: () => Promise<void>,
    private readonly onDidShow: () => void,
  ) {}

  get isWriting(): boolean {
    return this.writing;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.onDidShow();
      }
    });
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const data = message as {
        type?: string;
        values?: Partial<ManimNotebookSettings>;
      };
      if (data.type === "ready") {
        this.refresh();
        this.onDidShow();
        return;
      }
      if (data.type === "apply") {
        await this.onDidUpdate();
        void vscode.window.showInformationMessage("场景设置已应用到当前 Notebook 的 Scene cells。");
        return;
      }
      if (data.type === "update" && data.values) {
        await this.update(data.values);
      }
    });
  }

  refresh(): void {
    void this.view?.webview.postMessage({
      type: "state",
      values: this.readSettings(),
    });
  }

  private async update(values: Partial<ManimNotebookSettings>): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("manimJupyter");
    const target = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    this.writing = true;
    try {
      for (const key of CONFIG_KEYS) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          await configuration.update(key, values[key], target);
        }
      }
      this.refresh();
      await this.onDidUpdate();
    } finally {
      this.writing = false;
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px 12px 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: 13px; }
    .themes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin-bottom: 10px; }
    .theme { min-width: 0; padding: 3px; border: 1px solid var(--vscode-panel-border); border-radius: 2px; color: var(--vscode-foreground); background: transparent; font: 11px var(--vscode-font-family); cursor: pointer; }
    .theme:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .theme.active { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .swatch { display: block; height: 19px; margin-bottom: 3px; border: 1px solid rgba(127,127,127,.45); border-radius: 1px; }
    .field { margin: 9px 0; }
    .label { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 4px; color: var(--vscode-foreground); }
    .value { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .colors { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .color-control { display: grid; grid-template-columns: 32px 1fr; align-items: center; gap: 6px; min-height: 28px; padding: 2px 5px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); }
    input[type=color] { width: 28px; height: 22px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .color-text { min-width: 0; overflow: hidden; color: var(--vscode-input-foreground); font: 11px var(--vscode-editor-font-family); text-overflow: ellipsis; }
    input[type=range] { width: 100%; margin: 2px 0; accent-color: var(--vscode-progressBar-background); }
    .native-select { width: 100%; min-height: 28px; padding: 3px 24px 3px 7px; border: 1px solid var(--vscode-dropdown-border, var(--vscode-contrastBorder, transparent)); border-radius: 0; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); font: 13px var(--vscode-font-family); cursor: pointer; }
    .native-select:hover { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .native-select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .checks { display: grid; gap: 7px; margin-top: 11px; }
    .check { display: grid; grid-template-columns: 16px 1fr; gap: 6px; align-items: start; line-height: 1.35; }
    input[type=checkbox] { width: 14px; height: 14px; margin: 1px 0 0; accent-color: var(--vscode-checkbox-selectBackground); }
    .apply { width: 100%; min-height: 29px; margin-top: 12px; border: 1px solid transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: 13px var(--vscode-font-family); cursor: pointer; }
    .apply:hover { background: var(--vscode-button-hoverBackground); }
    .hint { margin: 9px 0 0; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
    @media (max-width: 260px) { .themes { grid-template-columns: repeat(2, 1fr); } .colors { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="themes" aria-label="主题预设">
    <button type="button" class="theme" data-theme="dark" data-bg="#0E1117" data-fg="#F8FAFC"><span class="swatch" style="background:#0E1117"></span>黑色</button>
    <button type="button" class="theme" data-theme="light" data-bg="#FFFFFF" data-fg="#111827"><span class="swatch" style="background:#FFFFFF"></span>白色</button>
    <button type="button" class="theme" data-theme="paper" data-bg="#F4EAD5" data-fg="#2F2A24"><span class="swatch" style="background:#F4EAD5"></span>纸张</button>
    <button type="button" class="theme" data-theme="blueprint" data-bg="#0B1F33" data-fg="#EAF4FF"><span class="swatch" style="background:#0B1F33"></span>蓝图</button>
  </div>

  <div class="colors">
    <div class="field"><div class="label"><span>背景</span></div><label class="color-control"><input id="backgroundColor" type="color"><span class="color-text" id="backgroundText"></span></label></div>
    <div class="field"><div class="label"><span>前景</span></div><label class="color-control"><input id="foregroundColor" type="color"><span class="color-text" id="foregroundText"></span></label></div>
  </div>

  <div class="field"><div class="label"><span>画幅</span><span class="value" id="resolutionText"></span></div><select id="aspectRatio" class="native-select"><option value="16:9">16:9 · 宽屏</option><option value="4:3">4:3 · 传统演示</option><option value="1:1">1:1 · 方形</option><option value="9:16">9:16 · 竖屏</option></select></div>
  <div class="field"><div class="label"><span>宽度</span><span class="value" id="pixelWidthText"></span></div><input id="pixelWidth" type="range" min="320" max="3840" step="160"></div>
  <div class="field"><div class="label"><span>帧率</span><span class="value" id="frameRateText"></span></div><input id="frameRate" type="range" min="1" max="120" step="1"></div>
  <div class="field"><div class="label"><span>Cell 视频宽度</span><span class="value" id="mediaWidthText"></span></div><input id="mediaWidth" type="range" min="25" max="100" step="5"></div>
  <div class="field"><div class="label"><span>质量预设</span></div><select id="quality" class="native-select"><option value="l">快速预览 · 480p15</option><option value="m">中等 · 720p30</option><option value="h">高清 · 1080p60</option><option value="p">制作 · 1440p60</option><option value="k">4K · 2160p60</option></select></div>
  <div class="field"><div class="label"><span>渲染器</span></div><select id="renderer" class="native-select"><option value="cairo">Cairo · 默认兼容</option><option value="opengl">OpenGL · GPU</option></select></div>
  <div class="checks">
    <label class="check"><input id="disableCaching" type="checkbox"><span>每次预览禁用缓存</span></label>
  </div>
  <button type="button" id="apply" class="apply">应用到当前 Notebook</button>
  <p class="hint">主题与颜色会立即保存；“应用”会把设置同步到当前 Notebook 中已有的 Scene cells。</p>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = Object.fromEntries(['quality','renderer','aspectRatio','disableCaching','backgroundColor','foregroundColor','pixelWidth','frameRate','mediaWidth'].map(id => [id, document.getElementById(id)]));
    const ratios = {'16:9':16/9,'4:3':4/3,'1:1':1,'9:16':9/16};
    let state = {quality:'m',renderer:'cairo',aspectRatio:'16:9',theme:'dark'};
    let colorTimer;
    function labels() {
      document.getElementById('backgroundText').textContent = el.backgroundColor.value.toUpperCase();
      document.getElementById('foregroundText').textContent = el.foregroundColor.value.toUpperCase();
      document.getElementById('pixelWidthText').textContent = el.pixelWidth.value + ' px';
      document.getElementById('frameRateText').textContent = el.frameRate.value + ' FPS';
      document.getElementById('mediaWidthText').textContent = el.mediaWidth.value + '%';
      document.getElementById('resolutionText').textContent = el.pixelWidth.value + '×' + Math.round(Number(el.pixelWidth.value) / ratios[state.aspectRatio]);
      document.querySelectorAll('[data-theme]').forEach(button => button.classList.toggle('active', button.dataset.theme === state.theme));
    }
    function send(values) { vscode.postMessage({type:'update', values}); }
    function sendColor(id, value) {
      clearTimeout(colorTimer);
      colorTimer = undefined;
      send({theme:'custom', [id]:value});
    }
    function setTheme(button) {
      clearTimeout(colorTimer);
      colorTimer = undefined;
      state.theme = button.dataset.theme;
      el.backgroundColor.value = button.dataset.bg;
      el.foregroundColor.value = button.dataset.fg;
      labels();
      send({theme:state.theme, backgroundColor:button.dataset.bg, foregroundColor:button.dataset.fg});
    }
    window.addEventListener('message', event => {
      if (event.data.type !== 'state') return;
      state = event.data.values;
      for (const id of Object.keys(el)) {
        if (id === 'mediaWidth') el[id].value = parseInt(state[id], 10);
        else if (el[id].type === 'checkbox') el[id].checked = Boolean(state[id]);
        else el[id].value = state[id];
      }
      labels();
    });
    document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => setTheme(button)));
    for (const id of ['quality','renderer','aspectRatio']) {
      el[id].addEventListener('change', () => {
        state[id] = el[id].value;
        labels();
        send({[id]:el[id].value});
      });
    }
    for (const id of ['pixelWidth','frameRate','mediaWidth']) {
      el[id].addEventListener('input', labels);
      el[id].addEventListener('change', () => {
        let value = id === 'mediaWidth' ? el[id].value + '%' : Number(el[id].value);
        send({[id]:value});
      });
    }
    for (const id of ['disableCaching']) {
      el[id].addEventListener('change', () => send({[id]:el[id].checked}));
    }
    for (const id of ['backgroundColor','foregroundColor']) {
      el[id].addEventListener('input', () => {
        state.theme = 'custom';
        labels();
        clearTimeout(colorTimer);
        colorTimer = setTimeout(() => sendColor(id, el[id].value), 80);
      });
      el[id].addEventListener('change', () => sendColor(id, el[id].value));
    }
    document.getElementById('apply').addEventListener('click', () => vscode.postMessage({type:'apply'}));
    vscode.postMessage({type:'ready'});
  </script>
</body>
</html>`;
  }
}
