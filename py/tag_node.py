import yaml
import os
import re
import json
import aiohttp

from aiohttp import web
from server import PromptServer

class TagNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True
                })
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "run"
    CATEGORY = "Custom"

    def run(self, text):
        return (text,)

NODE_CLASS_MAPPINGS = {
    "TagNode": TagNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TagNode": "Tag Selector Node"
}


# =========================
# 🔥 태그 그룹 색상 서버 저장 API (라이브러리 없이 텍스트 직접 수정)
# =========================

# 🔥 이 파일(tag_node.py) 기준이 아니라, 커스텀노드 루트 폴더 기준 web/ko_KR.yaml 경로
# tag_node.py가 <root>/py/tag_node.py 에 있다고 가정
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YAML_PATH = os.path.join(BASE_DIR, "web", "ko_KR.yaml")

IMAGE_DIR = os.path.join(BASE_DIR, "web", "image")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

_image_manifest_cache = None

def build_image_manifest():
    """image 폴더를 스캔해서 { tag: [파일명, ...] } 형태로 반환"""
    manifest = {}

    if not os.path.isdir(IMAGE_DIR):
        return manifest

    for filename in os.listdir(IMAGE_DIR):
        name, ext = os.path.splitext(filename)
        if ext.lower() not in IMAGE_EXTENSIONS:
            continue

        m = re.match(r"^(.*)_(\d+)$", name)
        tag = m.group(1) if m else name

        manifest.setdefault(tag, []).append(filename)

    def sort_key(fn):
        n, _ = os.path.splitext(fn)
        m = re.match(r"^(.*)_(\d+)$", n)
        return int(m.group(2)) if m else -1

    for tag in manifest:
        manifest[tag].sort(key=sort_key)

    return manifest


@PromptServer.instance.routes.get("/tagnode/image_manifest")
async def get_image_manifest(request):
    # 🔥 캐시 없이 매번 새로 스캔 - 이미지 추가/삭제가 새로고침만으로 바로 반영됨
    manifest = build_image_manifest()
    return web.json_response(manifest)

def _line_indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _extract_dash_name(stripped: str):
    """'- name: 개체' 형태에서 이름만 뽑음. 아니면 None."""
    m = re.match(r"-\s*name:\s*(.+)", stripped)
    if not m:
        return None
    val = m.group(1).strip()
    val = re.split(r"\s+#", val)[0].strip()   # 줄 끝 주석 제거
    val = val.strip("\"'")                    # 따옴표 제거
    return val


def update_color_in_yaml_text(text: str, category_name: str, group_name: str, new_color: str) -> str:
    lines = text.splitlines(keepends=True)
    n = len(lines)

    category_indent = None
    in_category = False

    i = 0
    while i < n:
        stripped = lines[i].strip()
        indent = _line_indent(lines[i])
        name = _extract_dash_name(stripped)

        if name is None:
            i += 1
            continue

        if not in_category:
            if name == category_name:
                in_category = True
                category_indent = indent
            i += 1
            continue

        if indent <= category_indent:
            in_category = False
            if name == category_name:
                in_category = True
                category_indent = indent
            i += 1
            continue

        if name != group_name:
            i += 1
            continue

        # 🎯 타겟 그룹 발견 → color: 줄 탐색
        group_indent = indent
        j = i + 1
        color_line_idx = None

        while j < n:
            s2 = lines[j].strip()
            ind2 = _line_indent(lines[j])

            if s2 == "":
                j += 1
                continue
            if ind2 <= group_indent:
                break

            m_color = re.match(r"color:\s*(.*)", s2)
            if m_color:
                color_line_idx = j
                break

            j += 1

        if color_line_idx is not None:
            prefix_ws = lines[color_line_idx][:_line_indent(lines[color_line_idx])]
            newline_char = "\n" if lines[color_line_idx].endswith("\n") else ""
            lines[color_line_idx] = f"{prefix_ws}color: {new_color}{newline_char}"
        else:
            child_indent = group_indent + 2
            if i + 1 < n and lines[i + 1].strip():
                child_indent = _line_indent(lines[i + 1])
            insert_line = " " * child_indent + f"color: {new_color}\n"
            lines.insert(i + 1, insert_line)

        return "".join(lines)

    raise ValueError(f"category '{category_name}' / group '{group_name}' 를 찾을 수 없습니다")

# =========================
# 🔥 자동 번역기능
# =========================
GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single"


async def google_translate(text: str, source: str = "ko", target: str = "en") -> str:
    params = {
        "client": "gtx",
        "sl": source,
        "tl": target,
        "dt": "t",
        "q": text,
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(
            GOOGLE_TRANSLATE_URL,
            params=params,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            resp.raise_for_status()
            data = await resp.json(content_type=None)  # 구글이 text/html로 응답하는 경우가 있어 content_type 체크 생략

            # 응답 형태: [[["번역결과", "원문", None, None, ...], [...], ...], ...]
            translated = "".join(chunk[0] for chunk in data[0] if chunk[0])
            return translated


@PromptServer.instance.routes.post("/tagnode/translate")
async def translate_text(request):
    try:
        body = await request.json()
        text = (body.get("text") or "").strip()
        source = body.get("source", "ko")
        target = body.get("target", "en")

        if not text:
            return web.json_response({"error": "empty text"}, status=400)

        translated = await google_translate(text, source, target)
        return web.json_response({"translated": translated})

    except Exception as e:
        print("[TagNode] 번역 실패:", e)
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/tagnode/update_color")
async def update_group_color(request):
    try:
        body = await request.json()
        category_name = body.get("category")
        group_name = body.get("group")
        new_color = body.get("color")

        if not (category_name and group_name and new_color):
            return web.json_response({"error": "missing params"}, status=400)

        with open(YAML_PATH, "r", encoding="utf-8") as f:
            text = f.read()

        new_text = update_color_in_yaml_text(text, category_name, group_name, new_color)

        with open(YAML_PATH, "w", encoding="utf-8") as f:
            f.write(new_text)

        return web.json_response({"success": True})

    except ValueError as e:
        return web.json_response({"error": str(e)}, status=404)
    except Exception as e:
        print("[TagNode] YAML 색상 저장 실패:", e)
        return web.json_response({"error": str(e)}, status=500)