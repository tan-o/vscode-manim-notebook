import * as vscode from "vscode";

interface ActionDefinition {
  label: string | (() => string);
  description: string | (() => string);
  icon: string;
  command: string;
}

const ACTIONS: ActionDefinition[] = [
  { label: "新建 Manim Notebook", description: "纯 Scene 源码，一 Cell 一页", icon: "new-file", command: "manimJupyter.newNotebook" },
  { label: "打开 Manim Notebook", description: "只接受 *.manim.ipynb", icon: "folder-opened", command: "manimJupyter.openNotebook" },
  { label: "播放 Jupyter HTML Slides", description: "RevealJS 交互分段 · 无 Qt", icon: "play-circle", command: "manimJupyter.playPresentation" },
  { label: "导出 PowerPoint", description: "每个 Manim 动画一页并自动播放", icon: "file-media", command: "manimJupyter.exportPptx" },
  { label: "检查 Python 环境", description: "运行、Slides、PPTX、Typst", icon: "beaker", command: "manimJupyter.checkKernel" },
  {
    label: () => {
      const enabled = vscode.workspace.getConfiguration("manimJupyter")
        .get<boolean>("videoLoop", false);
      return `视频循环播放：${enabled ? "开" : "关"}`;
    },
    description: "Cell 输出和右侧预览的视频循环；不影响 PPT",
    icon: "debug-restart",
    command: "manimJupyter.toggleVideoLoop",
  },
];

export class OperationsTreeProvider implements vscode.TreeDataProvider<ActionDefinition> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(item: ActionDefinition): vscode.TreeItem {
    const label = typeof item.label === "function" ? item.label() : item.label;
    const description = typeof item.description === "function" ? item.description() : item.description;
    const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    treeItem.description = description;
    treeItem.iconPath = new vscode.ThemeIcon(item.icon);
    treeItem.command = { command: item.command, title: label };
    return treeItem;
  }

  getChildren(): ActionDefinition[] {
    return ACTIONS;
  }
}
