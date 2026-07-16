class ExifViewer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("STRING", {"multiline": True, "default": ""}),
                "negative": ("STRING", {"multiline": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "get_prompts"
    OUTPUT_NODE = True
    CATEGORY = "utils"

    def get_prompts(self, positive, negative):
        return (positive, negative)


NODE_CLASS_MAPPINGS = {
    "ExifViewer": ExifViewer
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ExifViewer": "EXIF Viewer"
}
