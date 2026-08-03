"""Private kernel runtime for ``*.manim.ipynb`` notebooks.

The VS Code extension injects this module into its private Jupyter kernel. The
TypeScript controller decides whether a Cell is Python or Manim and wraps only
explicit Manim Cells before execution.
"""

import logging as _manim_jupyter_logging
import mimetypes as _manim_jupyter_mimetypes
from pathlib import Path as _ManimJupyterPath

from IPython.display import clear_output as _manim_jupyter_clear_output
from manim import *
import manim.utils.ipython_magic as _manim_jupyter_ipython_magic
from manim_slides import Slide as _ManimJupyterSlide
from manim_slides import ThreeDSlide as _ManimJupyterThreeDSlide
from manim_slides.config import BaseSlideConfig as _ManimJupyterBaseSlideConfig


_manim_jupyter_options = globals().get("_MANIM_JUPYTER_BOOTSTRAP", {})
_MANIM_JUPYTER_CELL_SETTINGS = _manim_jupyter_options.get("cellSettings", {})
_MANIM_JUPYTER_ACTIVE_CELL_SETTINGS = {}
_MANIM_JUPYTER_MAGIC_ARGS = _manim_jupyter_options.get(
    "magicArgs", "-ql -v WARNING --progress_bar display {scene}"
)
MANIM_THEME = _manim_jupyter_options.get("theme", "dark")
MANIM_FOREGROUND = _manim_jupyter_options.get("foregroundColor", "#F8FAFC")

config.media_width = _manim_jupyter_options.get("mediaWidth", "100%")
# The companion renderer reads the generated file in bounded chunks. Never
# turn a video into a base64 HTML string: that multiplies its memory use across
# the Python kernel, extension host, notebook model, and output webview.
config.media_embed = False
config.progress_bar = "display"
config.background_color = _manim_jupyter_options.get("backgroundColor", "#0E1117")
config.frame_width = config.frame_height * float(_manim_jupyter_options.get("aspect", 16 / 9))
_manim_jupyter_logging.getLogger("manim-slides").setLevel(_manim_jupyter_logging.WARNING)

_MANIM_JUPYTER_VIDEO_MIME = "application/vnd.manim.video+json"
_ManimJupyterOriginalVideo = globals().get(
    "_ManimJupyterOriginalVideo", _manim_jupyter_ipython_magic.Video
)


class _ManimJupyterBoundedVideo(_ManimJupyterOriginalVideo):
    """Expose a file descriptor instead of an in-memory base64 video."""

    def __init__(self, data=None, url=None, filename=None, embed=False, *args, **kwargs):
        super().__init__(
            data=data,
            url=url,
            filename=filename,
            embed=False,
            *args,
            **kwargs,
        )

    def _repr_mimebundle_(self, include=None, exclude=None):
        if self.filename:
            # Keep rendering progress visible while Manim is working, then
            # atomically replace it with the only persistent output: the video.
            _manim_jupyter_clear_output(wait=True)
            candidate = _ManimJupyterPath(self.filename).resolve()
            scene_names = config.get("scene_names") or []
            scene_name = scene_names[0] if scene_names else ""
            options = _MANIM_JUPYTER_ACTIVE_CELL_SETTINGS or _MANIM_JUPYTER_CELL_SETTINGS.get(scene_name, {})
            mime_type = self.mimetype or _manim_jupyter_mimetypes.guess_type(candidate)[0]
            return {
                _MANIM_JUPYTER_VIDEO_MIME: {
                    "path": str(candidate),
                    "mimeType": mime_type or "video/mp4",
                    "loop": bool(_manim_jupyter_options.get("videoLoop", False)),
                    "controls": bool(options.get("controls", True)),
                    "playbackRate": float(options.get("playbackRate", 1.0)),
                    "width": str(config.media_width or "100%"),
                },
                "text/plain": f"Manim video: {candidate.name}",
            }
        return {"text/html": super()._repr_html_()}


_manim_jupyter_ipython_magic.Video = _ManimJupyterBoundedVideo

_ManimJupyterManimScene = Scene
_ManimJupyterManimThreeDScene = ThreeDScene
Scene = _ManimJupyterSlide
ThreeDScene = _ManimJupyterThreeDSlide
Slide = _ManimJupyterSlide
ThreeDSlide = _ManimJupyterThreeDSlide


_manim_jupyter_ip = get_ipython()
_manim_jupyter_ip.register_magics(_manim_jupyter_ipython_magic.ManimMagic)


def _ManimJupyterAutoPlayMedia(media, loop=False):
    """Make a python-pptx movie start when its slide is shown.

    This mirrors the timing XML that manim-slides applies to PPTX output:
    keep the generated ``p:video`` sequence, but replace its start condition
    delays with ``0`` so the animation begins as soon as the page becomes
    visible. The normal python-pptx movie starts on click and uses
    ``delay="indefinite"``; PowerPoint treats a zero delay as automatic.
    """
    import lxml.etree as _manim_jupyter_etree

    nsmap = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main"}

    def xpath(element, query):
        return _manim_jupyter_etree.ElementBase.xpath(
            element, query, namespaces=nsmap
        )

    media_id = xpath(media.element, ".//p:cNvPr")[0].attrib["id"]
    media_node = xpath(
        media.element.getparent().getparent().getparent(),
        f'.//p:timing//p:video//p:spTgt[@spid="{media_id}"]',
    )[0]
    video_node = media_node.getparent().getparent()
    for condition in xpath(video_node, ".//p:cond"):
        condition.set("delay", "0")

    if loop:
        time_node = xpath(video_node, ".//p:cTn")[0]
        time_node.set("repeatCount", "indefinite")


def _ManimJupyterBuildPptx(video_files, destination, loop=False):
    """Build one PowerPoint slide per rendered Manim partial movie."""
    import mimetypes as _manim_jupyter_mimetypes
    import tempfile as _manim_jupyter_tempfile

    from manim_slides.convert import (
        FrameIndex as _ManimJupyterFrameIndex,
        read_image_from_video_file as _ManimJupyterReadFrame,
    )
    from pptx import Presentation as _ManimJupyterPresentation

    if not video_files:
        raise ValueError("没有可导出的 Manim 动画；请至少使用一次 self.play(...) 或 self.wait(...)。")

    prs = _ManimJupyterPresentation()
    resolution = globals().get("_MANIM_JUPYTER_PPTX_RESOLUTION")
    if not (
        isinstance(resolution, (tuple, list))
        and len(resolution) == 2
        and all(isinstance(value, int) and value > 0 for value in resolution)
    ):
        resolution = (
            int(config.get("pixel_width") or 1280),
            int(config.get("pixel_height") or 720),
        )
    pixel_width, pixel_height = resolution
    prs.slide_width = pixel_width * 9525
    prs.slide_height = pixel_height * 9525
    layout = prs.slide_layouts[6]  # blank layout

    with _manim_jupyter_tempfile.TemporaryDirectory() as directory_name:
        directory = _ManimJupyterPath(directory_name)
        for index, video_file in enumerate(video_files):
            video_path = _ManimJupyterPath(video_file)
            if not video_path.is_file():
                raise ValueError(f"Manim 动画视频不存在：{video_path}")

            poster_path = directory / f"{index:05d}.png"
            _ManimJupyterReadFrame(video_path, _ManimJupyterFrameIndex.first).save(
                poster_path
            )

            slide = prs.slides.add_slide(layout)
            mime_type = (
                _manim_jupyter_mimetypes.guess_type(video_path)[0] or "video/mp4"
            )
            movie = slide.shapes.add_movie(
                str(video_path),
                0,
                0,
                prs.slide_width,
                prs.slide_height,
                poster_frame_image=str(poster_path),
                mime_type=mime_type,
            )
            _ManimJupyterAutoPlayMedia(movie, loop=loop)

    destination = _ManimJupyterPath(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    prs.save(destination)


_MANIM_JUPYTER_READY = True
