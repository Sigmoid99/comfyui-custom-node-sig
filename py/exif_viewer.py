class ExifViewer:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    CATEGORY = "utils"

    def noop(self):
        return {}

NODE_CLASS_MAPPINGS = {
    "ExifViewer": ExifViewer
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ExifViewer": "EXIF Viewer"
}
