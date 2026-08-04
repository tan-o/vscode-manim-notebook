"""Small integration smoke test for the strict private IPython runtime."""

from pathlib import Path
import json
import sys

from IPython.core.interactiveshell import InteractiveShell


shell = InteractiveShell.instance()
namespace = shell.user_ns
namespace["get_ipython"] = lambda: shell
namespace["_MANIM_JUPYTER_BOOTSTRAP"] = {
    "theme": "dark",
    "cellSettings": {},
    "videoLoop": True,
}
startup = Path(__file__).parents[1] / "python" / "manim_jupyter_startup.py"
exec(compile(startup.read_text(encoding="utf-8"), str(startup), "exec"), namespace)

original_scene_bases = {
    name: namespace[name]
    for name in (
        "_ManimJupyterManimScene",
        "_ManimJupyterManimThreeDScene",
        "_ManimJupyterManimMovingCameraScene",
        "_ManimJupyterManimZoomedScene",
        "_ManimJupyterManimVectorScene",
        "_ManimJupyterManimLinearTransformationScene",
        "_ManimJupyterManimSpecialThreeDScene",
    )
}
exec(compile(startup.read_text(encoding="utf-8"), str(startup), "exec"), namespace)
for name, scene_base in original_scene_bases.items():
    assert namespace[name] is scene_base

assert namespace["_MANIM_JUPYTER_READY"] is True
assert namespace["config"].media_embed is False
assert None not in shell.input_transformers_cleanup

scene_bases = {
    "Scene": "_ManimJupyterManimScene",
    "ThreeDScene": "_ManimJupyterManimThreeDScene",
    "MovingCameraScene": "_ManimJupyterManimMovingCameraScene",
    "ZoomedScene": "_ManimJupyterManimZoomedScene",
    "VectorScene": "_ManimJupyterManimVectorScene",
    "LinearTransformationScene": "_ManimJupyterManimLinearTransformationScene",
    "SpecialThreeDScene": "_ManimJupyterManimThreeDScene",
}
for scene_name, original_name in scene_bases.items():
    scene_class = namespace[scene_name]
    assert issubclass(scene_class, namespace["_ManimJupyterSlide"])
    assert issubclass(scene_class, namespace[original_name])

assert hasattr(namespace["ThreeDScene"], "set_camera_orientation")
assert hasattr(namespace["MovingCameraScene"], "get_moving_mobjects")
assert hasattr(namespace["ZoomedScene"], "activate_zooming")
assert hasattr(namespace["VectorScene"], "add_vector")
assert hasattr(namespace["LinearTransformationScene"], "apply_matrix")
assert hasattr(namespace["SpecialThreeDScene"], "set_camera_orientation")


class _ProgressRenderer:
    num_plays = 1
    skip_animations = False


class _ProgressScene:
    renderer = _ProgressRenderer()


original_frame_rate = namespace["config"].frame_rate
namespace["config"].frame_rate = 2
namespace["_MANIM_JUPYTER_PPTX_CAPTURE_TAIL"] = True
held_samples = list(namespace["_ManimJupyterTimeProgression"](
    [0.0, 0.5],
    _ProgressScene(),
    1.0,
    "held PPT boundary",
))
namespace["_MANIM_JUPYTER_PPTX_CAPTURE_TAIL"] = False
normal_samples = list(namespace["_ManimJupyterTimeProgression"](
    [0.0, 0.5],
    _ProgressScene(),
    1.0,
    "normal boundary",
))
namespace["config"].frame_rate = original_frame_rate
assert held_samples == [0.0, 0.5, 1.0]
assert normal_samples == [0.0, 0.5]

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
    assert videos[-1]["loop"] is True
    assert all("data:video/" not in output.get("text/html", "") for output in published)
    for scene_name in scene_bases:
        published.clear()
        smoke_name = f"_Manim{scene_name}Smoke"
        scene_setup = (
            "        self.set_camera_orientation(phi=60 * DEGREES, theta=-45 * DEGREES)\n"
            if scene_name in ("ThreeDScene", "SpecialThreeDScene")
            else ""
        )
        scene_object = "self.get_axes()" if scene_name == "SpecialThreeDScene" else "Dot()"
        scene_result = shell.run_cell(
            '# <manim-jupyter-wrapped>\n'
            f'class {smoke_name}({scene_name}):\n'
            '    skip_reversing = True\n'
            '    def construct(self):\n'
            f'{scene_setup}'
            f'        self.add({scene_object})\n'
            '        self.wait(0.2)\n'
            '        self.next_slide()\n'
            '        self.wait(0.2)\n'
            f'get_ipython().run_line_magic("manim", "-ql -r 320,180 --fps 5 -v WARNING --progress_bar none --disable_caching {smoke_name}")\n'
        )
        assert scene_result.success, scene_name
        scene_videos = [
            output["application/vnd.manim.video+json"]
            for output in published
            if "application/vnd.manim.video+json" in output
        ]
        assert scene_videos and Path(scene_videos[-1]["path"]).is_file(), scene_name
    example = json.loads(
        (Path(__file__).parents[1] / "examples" / "scene-class-examples.manim.ipynb")
        .read_text(encoding="utf-8")
    )
    example_segments = []
    for cell in example["cells"]:
        metadata = cell.get("metadata", {}).get("manimJupyter")
        if cell.get("type") != "code" or metadata is None:
            continue
        scene_name = metadata["sceneClass"]
        if not example_segments or example_segments[-1][0] != scene_name:
            example_segments.append([scene_name, []])
        example_segments[-1][1].append(cell["source"])
    assert [segment[0] for segment in example_segments] == list(scene_bases)
    for segment_number, (scene_name, example_sources) in enumerate(example_segments):
        published.clear()
        example_body = "\n        self.next_slide()\n".join(
            "\n".join(f"        {line}" if line else "" for line in source.splitlines())
            for source in example_sources
        )
        example_name = f"_Manim{segment_number}{scene_name}Example"
        example_result = shell.run_cell(
            '# <manim-jupyter-wrapped>\n'
            f'class {example_name}({scene_name}):\n'
            '    skip_reversing = True\n'
            '    def construct(self):\n'
            f'{example_body}\n'
            f'get_ipython().run_line_magic("manim", "-ql -r 320,180 --fps 5 -v WARNING --progress_bar none --disable_caching {example_name}")\n'
        )
        assert example_result.success, scene_name
        example_videos = [
            output["application/vnd.manim.video+json"]
            for output in published
            if "application/vnd.manim.video+json" in output
        ]
        assert example_videos and Path(example_videos[-1]["path"]).is_file(), scene_name
    published.clear()
    preview = shell.run_cell(
        '# <manim-jupyter-wrapped>\n'
        'class _ManimLinePreviewSmoke(_ManimJupyterManimScene):\n'
        '    def construct(self):\n'
        '        assert hasattr(self, "renderer")\n'
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
    assert videos[-1]["loop"] is True
    assert all("data:video/" not in output.get("text/html", "") for output in published)
    published.clear()
    special_preview = shell.run_cell(
        '# <manim-jupyter-wrapped>\n'
        'class _ManimSpecialThreeDLinePreviewSmoke(_ManimJupyterSpecialThreeDPreview):\n'
        '    def construct(self):\n'
        '        assert hasattr(self, "renderer")\n'
        '        axes = self.get_axes()\n'
        '        sphere = self.get_sphere(color=BLUE, fill_opacity=0.55)\n'
        '        self.add(axes, sphere)\n'
        '        self.play(sphere.animate.set_fill(PURPLE, opacity=0.6), run_time=0.2)\n'
        'get_ipython().run_line_magic("manim", "-ql -r 320,180 --fps 5 -v WARNING --progress_bar none --disable_caching _ManimSpecialThreeDLinePreviewSmoke")\n'
    )
    assert special_preview.success
    special_videos = [
        output["application/vnd.manim.video+json"]
        for output in published
        if "application/vnd.manim.video+json" in output
    ]
    assert special_videos and Path(special_videos[-1]["path"]).is_file()
    shell.display_pub.publish = original_publish
print("strict startup and explicit Manim render smoke test passed")
