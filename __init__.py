import importlib.util
import os
import glob

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 현재 폴더 기준 py 디렉토리
BASE_DIR = os.path.dirname(__file__)
PY_DIR = os.path.join(BASE_DIR, "py")

# py 폴더 안의 모든 .py 파일 가져오기
files = glob.glob(os.path.join(PY_DIR, "*.py"))

for file in files:
    module_name = os.path.splitext(os.path.basename(file))[0]

    spec = importlib.util.spec_from_file_location(module_name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # NODE_CLASS_MAPPINGS 합치기
    if hasattr(module, "NODE_CLASS_MAPPINGS"):
        NODE_CLASS_MAPPINGS.update(module.NODE_CLASS_MAPPINGS)

    # DISPLAY_NAME도 있으면 합치기
    if hasattr(module, "NODE_DISPLAY_NAME_MAPPINGS"):
        NODE_DISPLAY_NAME_MAPPINGS.update(module.NODE_DISPLAY_NAME_MAPPINGS)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]