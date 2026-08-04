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
    progress_events = []
    while True:
        response = receive(process)
        assert response["id"] == request_id, response
        if response.get("type") == "progress":
            progress_events.append(response["progress"])
            continue
        assert response["ok"], response
        response["progressEvents"] = progress_events
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


def raw_video_frames(filename: Path, width: int, height: int) -> list[bytes]:
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(filename),
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    frame_size = width * height * 3
    assert result.stdout and len(result.stdout) % frame_size == 0, len(result.stdout)
    return [
        result.stdout[offset:offset + frame_size]
        for offset in range(0, len(result.stdout), frame_size)
    ]


def blue_centroid_x(frame: bytes, width: int) -> float:
    x_sum = 0
    count = 0
    for offset in range(0, len(frame), 3):
        red, green, blue = frame[offset:offset + 3]
        if blue > red + 40 and blue > green and green > red + 40:
            x_sum += (offset // 3) % width
            count += 1
    assert count > 100, count
    return x_sum / count


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
            "magicArgs": "-ql -r 640,360 --fps 15 -v WARNING --progress_bar none --renderer=cairo --disable_caching {scene}",
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
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --progress_bar none --renderer=cairo --disable_caching --save_last_frame _WorkerObjectSmoke")'''
        object_response = execute(process, 5, object_scene)
        assert_png(object_response)

        object_slide = '''# <manim-jupyter-wrapped>
class _WorkerObjectSlide(Scene):
    skip_reversing = True

    def construct(self):
        square = Square(side_length=2, color=BLUE).to_edge(LEFT)
        self.play(FadeIn(square), run_time=0.5)
        self.next_slide()
        self.play(square.animate.to_edge(RIGHT), run_time=0.5)
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --progress_bar none --renderer=cairo --disable_caching _WorkerObjectSlide")'''
        slide_response = execute(process, 6, object_slide)
        object_video = video_path(slide_response)
        assert video_duration(object_video) >= 0.9
        slide_config = json.loads((ROOT / "examples" / "slides" / "_WorkerObjectSlide.json").read_text())
        assert len(slide_config["slides"]) == 2
        assert slide_config["slides"][0]["file"] == slide_config["slides"][0]["rev_file"]

        pptx_path = ROOT / ".tmp-e2e" / "worker-progress-smoke.pptx"
        pptx_response = execute(
            process,
            7,
            f"_ManimJupyterBuildPptx({json.dumps([str(object_video), str(object_video)])}, {json.dumps(str(pptx_path))})",
        )
        assert pptx_path.is_file() and pptx_path.stat().st_size > 1000
        assert any(
            event.get("stage") == "packaging"
            and event.get("current") == 2
            and event.get("total") == 2
            and event.get("percent") == 100.0
            for event in pptx_response["progressEvents"]
        ), pptx_response
        assert any(
            event.get("stage") == "saving" and event.get("done") is True
            for event in pptx_response["progressEvents"]
        ), pptx_response

        # Hold each real play's endpoint in its own partial movie.
        tail_hold_body = '''        square = Square(side_length=1.5, color=BLUE, fill_opacity=1).to_edge(LEFT)
        self.play(FadeIn(square), run_time=0.4)
        self.wait(0.2)
        self.next_slide()
        self.play(Wait(0.2))
        self.play(square.animate.to_edge(RIGHT), run_time=0.4)'''
        tail_hold_scene = f'''# <manim-jupyter-wrapped>
_WORKER_PPT_TAIL_PARTIALS = []
class _WorkerPptTailHold(Scene):
    skip_reversing = True

    def render(self, *args, **kwargs):
        global _WORKER_PPT_TAIL_PARTIALS
        _WORKER_PPT_TAIL_PARTIALS = []
        original_play = self.play

        def capture_play(*play_args, **play_kwargs):
            global _MANIM_JUPYTER_PPTX_CAPTURE_TAIL
            before = list(self._partial_movie_files)
            is_wait = len(play_args) == 1 and isinstance(play_args[0], Wait)
            old_capture_tail = _MANIM_JUPYTER_PPTX_CAPTURE_TAIL
            _MANIM_JUPYTER_PPTX_CAPTURE_TAIL = not is_wait
            try:
                result = original_play(*play_args, **play_kwargs)
            finally:
                _MANIM_JUPYTER_PPTX_CAPTURE_TAIL = old_capture_tail
            new_partials = self._partial_movie_files[len(before):]
            if is_wait:
                return result
            _WORKER_PPT_TAIL_PARTIALS.extend(
                str(path) for path in new_partials
                if path is not None
            )
            return result

        self.play = capture_play
        try:
            _ManimJupyterManimScene.render(self, *args, **kwargs)
        finally:
            self.play = original_play

    def construct(self):
        self._base_slide_config = _ManimJupyterBaseSlideConfig()
        self.next_slide = lambda *args, **kwargs: None
{tail_hold_body}
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --progress_bar none --renderer=cairo --disable_caching _WorkerPptTailHold")
_ManimJupyterBuildPptx(_WORKER_PPT_TAIL_PARTIALS, {json.dumps(str(ROOT / ".tmp-e2e" / "tail-hold-export-smoke.pptx"))}, loop=False)
_manim_jupyter_json.dumps({{
    "partials": [str(_ManimJupyterPath(p).resolve()) for p in _WORKER_PPT_TAIL_PARTIALS],
}})'''
        tail_hold_response = execute(process, 8, tail_hold_scene)
        tail_hold_text = "\n".join(
            str(item.get("value", ""))
            for output in tail_hold_response["outputs"]
            for item in output["items"]
            if item.get("mime") in ("text/plain", "application/x.notebook.stream.stdout")
        )
        # Extract the JSON line from the Manim output.
        tail_hold_json_line = next(
            (line for line in tail_hold_text.splitlines() if '"partials"' in line),
            None,
        )
        assert tail_hold_json_line, tail_hold_text
        tail_hold_json_line = tail_hold_json_line.strip().strip("'").strip('"')
        tail_hold_paths = json.loads(tail_hold_json_line)
        tail_hold_partials = [Path(value) for value in tail_hold_paths["partials"]]
        assert len(tail_hold_partials) == 2, tail_hold_text
        held_frames = raw_video_frames(tail_hold_partials[0], 640, 360)
        expected_animation_frames = round(15 * 0.4)
        expected_tail_frames = round(15 * 0.5)
        assert len(held_frames) == expected_animation_frames + expected_tail_frames
        tail_delta = sum(
            abs(left - right)
            for left, right in zip(held_frames[-1], held_frames[-2])
        ) / len(held_frames[-1])
        assert tail_delta < 0.1, tail_delta
        tail_hold_pptx = ROOT / ".tmp-e2e" / "tail-hold-export-smoke.pptx"
        assert tail_hold_pptx.is_file() and tail_hold_pptx.stat().st_size > 1000
        import zipfile
        with zipfile.ZipFile(tail_hold_pptx) as z:
            media = [n for n in z.namelist() if n.startswith("ppt/media/") and n.endswith(".mp4")]
            assert len(media) == 2, media
            slides = [n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
            assert len(slides) == 2, slides

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
get_ipython().run_line_magic("manim", "-ql -r 640,360 --fps 15 -v WARNING --progress_bar none --renderer=cairo --disable_caching _WorkerAnimationSmoke")'''
        animation_response = execute(process, 11, animation_scene)
        video_path(animation_response)
        detailed = [
            event for event in animation_response["progressEvents"]
            if event.get("stage") == "rendering" and event.get("current", 0) > 0
        ]
        assert detailed, animation_response
        assert any(event.get("percent") == 100.0 for event in detailed), detailed
        assert any(event.get("fps", 0) > 0 for event in detailed), detailed
        assert any(event.get("realtime", 0) > 0 for event in detailed), detailed
        assert not any(
            "__MANIM_JUPYTER_PROGRESS__" in str(item.get("value", ""))
            for output in animation_response["outputs"] for item in output["items"]
        ), animation_response

        print("worker smoke: shared Python globals, live progress, persistent object slides, TypstMath, held-tail PPT export, and animation passed")
    finally:
        if process.stdin:
            process.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
            process.stdin.flush()
        process.wait(timeout=10)


if __name__ == "__main__":
    main()
