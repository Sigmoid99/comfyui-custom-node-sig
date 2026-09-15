import yaml
import os
import re
import json
import aiohttp
import urllib.parse

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
# 🔥 자동 번역기능 (batchexecute 우선 시도 → 실패 시 translate_a/single 폴백)
# =========================
GOOGLE_HOST_URL = "https://translate.google.com"
GOOGLE_API_PATH = "/_/TranslateWebserverUi/data/batchexecute"
GOOGLE_CONSENT_HOST = "consent.google.com"
GOOGLE_RPCID = "MkEWBc"

GOOGLE_SIMPLE_API_URL = "https://translate.googleapis.com/translate_a/single"

COMMON_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def _get_rpc_form_data(query_text: str, from_language: str, to_language: str) -> dict:
    """GoogleV2.get_rpc()와 동일한 방식으로 f.req 페이로드 생성"""
    param = json.dumps([[query_text, from_language, to_language, True], [1]])
    rpc = json.dumps([[[GOOGLE_RPCID, param, None, "generic"]]])
    return {"f.req": rpc}


async def _handle_consent_if_needed(session: aiohttp.ClientSession, resp: aiohttp.ClientResponse):
    """구글이 EU 등에서 쿠키 동의 페이지로 리다이렉트할 때 처리"""
    if GOOGLE_CONSENT_HOST not in str(resp.url):
        return await resp.text()

    consent_html = await resp.text()
    form_data = dict(re.findall(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', consent_html))

    action_match = re.search(r'<form[^>]*action="([^"]+)"', consent_html)
    consent_action = action_match.group(1) if action_match else "https://consent.google.com/save"

    async with session.post(
        consent_action,
        data=form_data,
        headers=COMMON_HEADERS,
        timeout=aiohttp.ClientTimeout(total=10),
    ) as consent_resp:
        return await consent_resp.text()


async def google_translate_batchexecute(text: str, source: str, target: str) -> str:
    """
    translate.google.com 웹페이지 → 쿠키 획득 → RPC 생성 → batchexecute POST → 결과 파싱
    """
    api_url = GOOGLE_HOST_URL + GOOGLE_API_PATH

    async with aiohttp.ClientSession(headers=COMMON_HEADERS) as session:

        # 1️⃣ 웹페이지 GET → 쿠키/세션 확보 (consent 페이지가 뜨면 처리)
        async with session.get(
            GOOGLE_HOST_URL,
            timeout=aiohttp.ClientTimeout(total=10),
            allow_redirects=True,
        ) as resp:
            await _handle_consent_if_needed(session, resp)

        # 2️⃣ RPC 페이로드 생성
        rpc_form = _get_rpc_form_data(text, source, target)
        rpc_body = urllib.parse.urlencode(rpc_form)

        api_headers = {
            **COMMON_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Referer": GOOGLE_HOST_URL + "/",
            "X-Same-Domain": "1",
        }

        # 3️⃣ batchexecute POST
        async with session.post(
            api_url,
            data=rpc_body,
            headers=api_headers,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as api_resp:
            api_resp.raise_for_status()
            raw_text = await api_resp.text()

    # 4️⃣ 응답 파싱
    lines = raw_text.splitlines()

    json_line = None
    for line in lines:
        line = line.strip()
        if line.startswith('[["wrb.fr"'):
            json_line = line
            break

    if json_line is None:
        raise ValueError("batchexecute 응답에서 JSON 라인을 찾지 못했습니다.")

    outer = json.loads(json_line)
    inner_json_str = outer[0][2]

    if not inner_json_str:
        raise ValueError("batchexecute 응답 내부 데이터가 비어있습니다.")

    data = json.loads(inner_json_str)

    segments = data[1][0][0][5] or data[1][0]
    translated = "".join(seg[0] for seg in segments if seg and seg[0])

    if not translated:
        raise ValueError("batchexecute 파싱 결과가 비어있습니다.")

    return translated


async def google_translate_simple(text: str, source: str, target: str) -> str:
    """
    기존 방식 (translate_a/single) - 폴백용
    """
    params = {
        "client": "gtx",
        "sl": source,
        "tl": target,
        "dt": "t",
        "q": text,
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(
            GOOGLE_SIMPLE_API_URL,
            params=params,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            resp.raise_for_status()
            data = await resp.json(content_type=None)

            translated = "".join(chunk[0] for chunk in data[0] if chunk[0])

            if not translated:
                raise ValueError("translate_a/single 파싱 결과가 비어있습니다.")

            return translated


async def google_translate(text: str, source: str = "ko", target: str = "en") -> str:
    """
    1차: batchexecute 방식 시도
    2차(실패 시): translate_a/single 방식으로 폴백
    """
    try:
        return await google_translate_batchexecute(text, source, target)
    except Exception as e:
        print(f"[TagNode] batchexecute 번역 실패, translate_a/single로 폴백: {e}")
        return await google_translate_simple(text, source, target)
    
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
