"""End-to-end smoke test for the private *.manim.ipynb Jupyter kernel gateway."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "python" / "manim_kernel_worker.py"
STARTUP = ROOT / "python" / "manim_jupyter_startup.py"
PREFIX = "__MANIM_JUPYTER_JSON__"


def receive(process: subprocess.Popen[str]) -> dict:
    assert process.stdout is not None
    while True:
        line = process.stdout.readline()
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"Worker stopped unexpectedly: {stderr}")
        if line.startswith(PREFIX):
            return json.loads(line[len(PREFIX):])


def execute(process: subprocess.Popen[str], request_id: int, code: str) -> dict:
    assert process.stdin is not None
    process.stdin.write(json.dumps({"id": request_id, "code": code}) + "\n")
    process.stdin.flush()
    response = receive(process)
    assert response["id"] == request_id, response
    assert response["ok"], response
    return response


def video_path(response: dict) -> Path:
    for output in response.get("outputs", []):
        for item in output.get("items", []):
            if item.get("mime") == "application/vnd.manim.video+json":
                value = item.get("value")
                if isinstance(value, str):
                    value = json.loads(value)
                candidate = Path(value["path"])
                assert candidate.is_file() and candidate.stat().st_size > 16
                return candidate
    raise AssertionError(response)


def video_duration(filename: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(filename),
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return float(result.stdout.strip())


def assert_png(response: dict) -> None:
    items = [
        item
        for output in response["outputs"]
        for item in output["items"]
        if item.get("mime") == "image/png" and item.get("value")
    ]
    assert items, response
    assert items[0].get("base64") is True, items[0]
    assert base64.b64decode(items[0]["value"]).startswith(b"\x89PNG\r\n\x1a\n"), items[0]


def main() -> None:
    process = subprocess.Popen(
        [sys.executable, "-u", str(WORKER)],
        cwd=ROOT / "examples",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        assert receive(process)["type"] == "ready"
        plain_python = execute(
            process,
            1,
            "(get_ipython().__class__.__module__, 'Circle' in globals())",
        )
        plain_text = "\n".join(
            str(item.get("value", ""))
            for output in plain_python["outputs"]
            for item in output["items"]
            if item.get("mime") == "text/plain"
        )
        assert "ipykernel.zmqshell" in plain_text and "False" in plain_text, plain_python

        payload = {
            "cellSettings": {},
            "magicArgs": "-ql -r 640,360 --fps 15 -v WARNING --progress_bar display --renderer=cairo --disable_caching {scene}",
            "theme": "light",
            "foregroundColor": "#111827",
            "mediaWidth": "100%",
            "backgroundColor": "#FFFFFF",
            "aspect": 16 / 9,
        }
        startup = f'''# <manim-jupyter-wrapped>
import json as _manim_jupyter_json
_MANIM_JUPYTER_BOOTSTRAP = _manim_jupyter_json.loads({json.dumps(json.dumps(payload))})
exec(compile(open({json.dumps(str(STARTUP))}, encoding="utf-8").read(), {json.dumps(str(STARTUP))}, "exec"))'''
        execute(process, 2, startup)
        normal = execute(
            process,
            3,
            "values = [n * n for n in range(4)]\n"
            "shared_side = 1.75\n"
            "def make_shared_square(color):\n"
            "    return Square(side_length=shared_side, color=color)\n"
            "values",
        )
        assert any(
            item.get("mime") == "text/plain" and "[0, 1, 4, 9]" in str(item.get("value"))
            for output in normal["outputs"] for item in output["items"]
        ), normal

        manim_like_python = execute(process, 4, "shape = Square(side_length=2)\nshape")
        assert not any(
            item.get("mime") == "application/vnd.manim.video+json"
            for output in manim_like_python["outputs"] for item in output["items"]
        ), manim_like_python

        object_scene = '''# <manim-jupyter-wrapped>
class _WorkerObjectSmoke(_ManimJupyterManimScene):
    def construct(self):
        # Both the function and variable were defined by the preceding plain
        # Python Cell in this same IPykernel.
        square = make_shared_square(BLUE).to_edge(LEFT)
        assert square.width == shared_side
        self.add(square)
        self.wait(1 / max(float(config.frame_rate), 1))
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --renderer=cairo --disable_caching --save_last_frame _WorkerObjectSmoke")'''
        assert_png(execute(process, 5, object_scene))

        object_slide = '''# <manim-jupyter-wrapped>
class _WorkerObjectSlide(Scene):
    skip_reversing = True

    def construct(self):
        square = Square(side_length=2, color=BLUE).to_edge(LEFT)
        self.play(FadeIn(square), run_time=0.5)
        self.next_slide()
        self.play(square.animate.to_edge(RIGHT), run_time=0.5)
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --renderer=cairo --disable_caching _WorkerObjectSlide")'''
        object_video = video_path(execute(process, 6, object_slide))
        assert video_duration(object_video) >= 0.9
        slide_config = json.loads((ROOT / "examples" / "slides" / "_WorkerObjectSlide.json").read_text())
        assert len(slide_config["slides"]) == 2
        assert slide_config["slides"][0]["file"] == slide_config["slides"][0]["rev_file"]

        animation_scene = '''# <manim-jupyter-wrapped>
class _WorkerAnimationSmoke(Scene):
    skip_reversing = True

    def construct(self):
        self.next_slide = lambda *args, **kwargs: None
        title = TypstMath(
            r"sum_(k=1)^n k = (n(n + 1)) / 2",
            color=MANIM_FOREGROUND,
        )
        self.play(Write(title))
        self.wait(0.1)
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --renderer=cairo --disable_caching _WorkerAnimationSmoke")'''
        video_path(execute(process, 7, animation_scene))
        print("worker smoke: shared Python globals, persistent object slides, TypstMath, and animation passed")
    finally:
        if process.stdin:
            process.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
            process.stdin.flush()
        process.wait(timeout=10)


if __name__ == "__main__":
    main()
