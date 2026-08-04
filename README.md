# Manim CE for Jupyter

这是一个不依赖微软官方 **Jupyter** 扩展的独立 Manim Notebook 插件。它只处理文件名以 **`.manim.ipynb`** 结尾的文档；禁用 Microsoft Jupyter 后仍能编辑和运行。若同时安装官方扩展，普通 `.ipynb` 仍完全归官方扩展所有。

插件会在 VS Code 的编辑器关联中只新增 `*.manim.ipynb → Manim Jupyter Notebook`；已有的 `*.ipynb → Jupyter Notebook` 关联保持不变。

## 运行模型

- 可见 Cell 中不再写入 `class ...`、`def construct(...)`、`from manim import *`、全局 `config` 或 `%manim`。
- Python Cell 与 Manim Cell 的编辑器语言都保持 `python`；Manim Cell 使用 `manimJupyter` 元数据，Python Cell 使用 `manimJupyterCellType: python` 标记，绝不根据源码内容猜测 Cell 类型。
- `.manim.ipynb` 使用插件自己的 Notebook 控制器，通过 `jupyter_client` 启动所选解释器的真实 IPykernel，并使用标准 execute request、IOPub 输出与中断机制；不调用 Microsoft Jupyter 的私有 API，也不写入全局 `jupyter.runStartupCommands`。
- 选择环境和运行普通 Python Cell 不会加载 Manim。只有明确的 Manim Cell 首次运行、预览或配置时才在同一个 Jupyter kernel 中加载 Manim 运行时。
- 普通 Python Cell 与 Manim Cell 共用同一个真实 IPykernel。先在 Python Cell 中执行得到的变量、函数、类和 import 会保留到内核重启，并可由后续 Manim Cell 直接调用。
- 环境仍由用户自行选择；插件不会替你选择，也不会改变普通 `.ipynb` 使用的 Microsoft Jupyter Kernel。
- 点击 VS Code 原生 **Run Cell** 后，Cell 使用原生执行状态和计时；Manim/manim-slides 日志不会进入输出区，完成后只留下最终预览（失败时保留错误）。
- 每个 Manim Cell 右下角显示自己的 Scene 基类；点击可在 `Scene`、`ThreeDScene`、`MovingCameraScene`、`ZoomedScene`、`VectorScene`、`LinearTransformationScene` 与 `SpecialThreeDScene` 之间独立切换。相同基类的连续 Manim Cell 合并为一个 Scene 段；基类变化时开始新段，不跨类型继承对象或相机状态。
- Cell、光标预览、HTML Slides 和 PowerPoint 导出共用实时进度协议：渲染阶段显示当前动画的帧数、百分比、FPS、实时倍率、耗时与 ETA；PPT 打包阶段显示准确页数和总体百分比。手动任务使用可取消的 VS Code 原生进度通知，自动光标预览只占用底部状态栏。
- 当前开发版 `.manim.ipynb` 使用插件自己的紧凑 v6 JSON 结构，每个 Manim Cell 都必须在自身元数据中保存 Scene 基类；不包含旧版格式迁移或向下兼容分支。

只有 `.manim.ipynb` 才识别 Manim Cell、对象预览与 PPT 元数据。普通 `.ipynb` 不进入任何 Manim 代码路径。

## 原生插入按钮与三类 Cell

- Notebook 顶部工具栏直接提供 **+ Manim**；点击一次立即插入 Manim Cell，不再弹出二次选择菜单，也不再把插入按钮错误地放进 Cell 右上角。VS Code 没有向扩展开放单元格之间那条原生 **+ 代码 / + Markdown** 内部菜单，因此不使用不受支持的私有菜单注入。
- 每个 Python/Manim 代码 Cell 的右上角都有 **⇄** 转换按钮；单击一次就在 Python 与 Manim 之间切换，不弹出选择框。
- **Manim Cell**：点击原生 **+ 代码** 或顶部 **+ Manim** 创建；这是 `.manim.ipynb` 中新增代码 Cell 的默认类型，后台透明包装为 Scene，默认开启一页 PPT、关闭自动播放。
- Manim Cell 的右下角会显示 **$(symbol-structure) Manim** 标记，和普通 Python Cell 一眼区分；代码语言仍是 Python，因此语法高亮、Pylance 补全和 Python 调试不受影响。
- **Python Cell**：用 Cell 右上角的 **⇄** 把 Manim Cell 显式转换为 Python Cell；它直接走真实 IPykernel/Jupyter 执行，不做 Manim 包装，并使用 Python/Pylance 原生代码提示与悬浮文档。
- **Markdown Cell**：完全复用 VS Code 内置的 `vscode.markdown-it-renderer` 原生 Markdown 渲染管线（与内置数学扩展相同的机制），只把数学引擎换成 Typst：`$...$` 与 `$$...$$` 由本机 Typst 编译为原生 MathML（`typst compile --features html --format html`）后直接在浏览器里排版，不经过 SVG 图片，也不依赖任何第三方数学渲染器。只对携带 `manimJupyterTypst` 元数据的 Markdown 单元格启用，普通 Notebook 的 Markdown 完全不受影响；行内公式随正文基线对齐，块公式居中放大并适配主题。光标进入公式后，右侧帮助自动切换到 Typst 离线符号说明，编辑器也提供离线代码式补全，例如输入 `int` 会优先提示 `integral` 和定积分模板。

插件不指定或自动选择 Python 环境；新 Notebook 由用户通过右上角的 Notebook 环境选择器自行选择。

完整验收样例位于 `examples/manim-jupyter-acceptance.manim.ipynb`，覆盖对象静态预览、多行动画、Typst Markdown、普通 Python Cell、自动播放与 PPT 元数据。
日常上手可直接打开 `examples/demo.manim.ipynb`，里面包含 Typst Markdown、Python 辅助 Cell 和坐标轴、公式、对象移动三类 Manim 动画。
综合对象与动画图鉴位于 `examples/manim-object-animation-gallery.manim.ipynb`，按章节覆盖常用 2D 图元、布尔运算、文本与 Typst、坐标系、变换、路径、updater、动画编排、图表和 SVG 资源，并说明 3D 场景边界。
七种 Scene 基类的综合案例位于 `examples/scene-class-examples.manim.ipynb`。它在同一份 Notebook 中为不同 Manim Cell 指定不同基类，并分别演示 2D、普通/特殊 3D、移动相机、局部放大、向量和线性变换。

## Jupyter HTML Slides 交互放映与 PPTX

Markdown 与普通 Python Cell 永远不会成为演示页。Manim Cell 按 Notebook 顺序和相邻基类分成一个或多个 `construct()`，其中启用演示的 Cell 负责开启新页：

- Cell 右上角的齿轮按钮设置是否加入 PPT、自动前进、循环播放、播放速度、视频控件和对象/动画预览。
- Cell 配置入口统一放在右上角齿轮，不再在状态栏或左侧快捷操作里重复放置同一个设置入口。
- **播放 Jupyter HTML Slides** 会把一个连续的 Manim Slide Scene 转换为 RevealJS HTML，并在 VS Code 内置 Webview 中原生放映（方向键 / 空格翻页，Esc 退出全屏）；打开放映时自动进入无侧边栏的全屏模式，退出全屏或关闭放映页后恢复 VS Code 侧边栏。不会启动 `manim-slides present` 的 Qt 播放器；RevealJS 已内置进插件，离线也能播放，不依赖任何 CDN；放映页右上角可一键转到系统浏览器打开同一份 HTML。
- Cell 输出和右侧语句预览始终自动播放。Cell 设置里的“自动播放”只控制 HTML Slides 是否在视频结束后自动切到下一页；默认关闭，保持 manim-slides 的默认手动翻页体验。
- 同一 Scene 段中，每个后续且启用演示的 Manim Cell 之前只插入一次 `self.next_slide()`；不会调用 `clear()`，因此下一 Cell 可以继续引用上一 Cell 创建的 Mobject。基类变化时会建立新的 Scene 段，变量、Mobject 和相机状态从该 Cell 重新开始。
- 只有对象定义（例如 `text_1 = Text(...)`）或只调用了 `self.add(...)` 而没有动画的片段，会自动补一个 `self.wait(1.0)` 定格：既保证每个 Cell 的输出是真正可见可自动播放的视频，也满足 Manim Slides “每页至少一个动画” 的校验，且不会清理任何对象。
- 用户自己写的 `self.next_slide()` 会保留为真实暂停点，一个 Manim Cell 可以包含多个交互步骤。方向键、空格或点击可前后导航；浏览器进入全屏后可用 `Esc` 退出全屏。
- **导出 PowerPoint** 使用独立的 Scene 渲染规则并直接读取 Manim 的 `partial_movie_files`：`next_slide()` 与独立的 `wait()` 完全忽略，每个真实 `self.play(...)` 恰好生成一页 PPT。PPT 专用渲染会在同一个动画视频内写入精确终点，并默认定格 0.5 秒，避免 PowerPoint 停在 0.99 一类的倒数第二帧；无需对视频做 FFmpeg/PyAV 切割或二次编码。每页视频切换后自动播放，并用本页视频生成 poster frame。PPTX 导出不再要求 Cell 勾选“一 Cell 一页 PPT”，也不会插入导出代码 Cell 或启动 Qt。
- HTML 放映由 Manim Slides 生成正向/反向交互片段并交给 RevealJS 导航；普通 Cell 输出仍是独立预览。


## 两种预览

- **Cell 下方输出**：当前 Cell 所在的连续同类 Scene 段最终渲染结果。输出中只保存很小的媒体描述，专用 renderer 从 Manim 文件分块载入视频；不再把整段视频转成 Base64 塞进 Python、Notebook 和 Webview 内存。
- **右侧“当前对象与动画预览”**：对象定义和 `shift`、`to_edge`、`next_to` 等位置调整显示静态末帧；`self.play(...)` / `self.wait(...)` 以及由光标所在辅助函数调用触发的动画，只输出该语句实际触发的一个动画片段。预览只执行当前 Cell 之前、且属于同一连续 Scene 段的代码来恢复状态；遇到不同基类立即截断。目标完成后立即停止，因此不会从无关 Scene 段播放到光标。
- **右侧上下文帮助按 Cell 类型自动切换**：光标在 Manim Cell 中时，自动解析光标所在 Manim API 的官方 Sphinx 页面（函数签名、参数、说明与示例，带本地缓存与离线回退）；光标在普通 Python Cell 中时，调用 VS Code 的 Python/Pylance 原生 LSP Hover；光标在 Markdown 的 `$...$` 或 Manim Cell 的 `TypstMath("...")` 中时，显示离线 Typst 数学符号与模板候选，且编辑器内同时提供同样的 Typst 自动补全。

单个视频超过 128 MiB 时会停止载入并提示降低质量或缩短 Cell，以防 VS Code 再次耗尽内存。

右侧下半部分按 Cell 类型切换：Manim Cell 使用 Manim Community 官方 Sphinx 文档；Markdown 的 Typst 数学公式显示本地符号说明和候选；Python Cell 调用 VS Code 的 Python/Pylance 原生 Hover，不会拿 Python 或 Typst 名称查询 Manim 文档。

## Typst 预设

左侧 **Typst 预设字符** 是可点击字符面板，包括：

- 希腊字母大小写与常见变体；
- 积分、求和、集合、关系、逻辑和箭头符号；
- 求和、积分、分式、根号、极限、矩阵和分段函数模板。

先把光标放进 `TypstMath(r"...")`，或者普通 Markdown 的 `$...$` 中，再点击字符或模板即可插入。点击插入的是 **Typst 源码**（如 `alpha`、`sum`、`frac(a, b)`），不是 Unicode 字符；模板类条目带 Tab 占位符，插入后可连续按 Tab 填写参数。

Markdown 中 `$...$` 始终是随正文排版的行内公式；`$$...$$` 才是单独居中并放大的行间公式。Typst MathML 通过 renderer 消息在内存中生成，不再写入 Cell 元数据，因此仅仅打开 Notebook 不会把文件标成“未保存”。Markdown 数学需要 `typst >= 0.13`（HTML/MathML 导出），旧版本会给出明确的升级提示。

## 环境

在 `.manim.ipynb` 右上角的 Notebook 环境选择器中选择 Python 环境。完整功能需要：

```powershell
python -m pip install -U "ipykernel>=6.29" "jupyter-client>=8" "manim-slides[manim]>=5.6"
typst --version
```

其中 IPykernel 与 Jupyter Client 提供普通 Python Cell 的标准 Jupyter 执行；Manim 与 Manim Slides 只服务于 Manim Cell。HTML 放映直接使用 Manim Slides 的 RevealJS 导出，不需要 PySide6、Qt、`nbconvert` 或 `nbformat`；`python-pptx` 用于 PPTX 导出。左侧快捷操作中的 **检查 Python 环境** 会列出这些能力和版本，并可把缺少的包安装到当前明确选中的环境。插件不会静默修改环境。

最小 Cell：

```python
equation = TypstMath(r"sum_(k=1)^n k = (n(n+1))/2", color=MANIM_FOREGROUND)
self.play(Write(equation))
self.next_slide()
self.play(equation.animate.to_edge(UP))
```

## 开发

```powershell
npm install
npm test
npm run package
```

`reference-sources/` 与 `upstream/` 只保存参考源码，并已排除在 VSIX 之外。
