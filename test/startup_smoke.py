"""Small integration smoke test for the strict private IPython runtime."""

from pathlib import Path
import sys

from IPython.core.interactiveshell import InteractiveShell


shell = InteractiveShell.instance()
namespace = shell.user_ns
namespace["get_ipython"] = lambda: shell
namespace["_MANIM_JUPYTER_BOOTSTRAP"] = {
    "theme": "dark",
    "cellSettings": {},
}
startup = Path(__file__).parents[1] / "python" / "manim_jupyter_startup.py"
exec(compile(startup.read_text(encoding="utf-8"), str(startup), "exec"), namespace)

assert namespace["_MANIM_JUPYTER_READY"] is True
assert namespace["config"].media_embed is False
assert None not in shell.input_transformers_cleanup

if "--render" in sys.argv:
    published = []
    original_publish = shell.display_pub.publish

    def capture_publish(data, *args, **kwargs):
        published.append(data)

    shell.display_pub.publish = capture_publish
    result = shell.run_cell(
        '# <manim-jupyter-wrapped>\n'
        'class _ManimWholeCellSmoke(Scene):\n'
        '    skip_reversing = True\n'
        '    def construct(self):\n'
        '        self.next_slide = lambda *args, **kwargs: None\n'
        '        title = TypstMath(\n'
        '            r"sum_(k=1)^n k = (n(n + 1)) / 2"\n'
        '            , color=MANIM_FOREGROUND\n'
        '        )\n'
        '        self.play(Write(title))\n'
        'get_ipython().run_line_magic("manim", "-ql -v WARNING _ManimWholeCellSmoke")\n'
    )
    assert result.success
    videos = [
        output["application/vnd.manim.video+json"]
        for output in published
        if "application/vnd.manim.video+json" in output
    ]
    assert videos
    assert Path(videos[-1]["path"]).is_file()
    assert all("data:video/" not in output.get("text/html", "") for output in published)
    published.clear()
    preview = shell.run_cell(
        '# <manim-jupyter-wrapped>\n'
        'class _ManimLinePreviewSmoke(_ManimJupyterManimScene):\n'
        '    def construct(self):\n'
        '        self.next_slide = lambda *args, **kwargs: None\n'
        '        title = TypstMath(\n'
        '            r"sum_(k=1)^n k = (n(n + 1)) / 2"\n'
        '            , color=MANIM_FOREGROUND\n'
        '        )\n'
        '        self.play(Write(title))\n'
        '        self.next_slide()\n'
        '        self.play(title.animate.to_edge(UP))\n'
        'get_ipython().run_line_magic("manim", "-ql -v WARNING -n 1,1 _ManimLinePreviewSmoke")\n'
    )
    assert preview.success
    videos = [
        output["application/vnd.manim.video+json"]
        for output in published
        if "application/vnd.manim.video+json" in output
    ]
    assert videos
    assert Path(videos[-1]["path"]).is_file()
    assert all("data:video/" not in output.get("text/html", "") for output in published)
    shell.display_pub.publish = original_publish
print("strict startup and explicit Manim render smoke test passed")
