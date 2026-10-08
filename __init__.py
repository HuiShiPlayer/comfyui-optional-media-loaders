from .optional_media_loaders import (
    OptionalLoadImage,   
    OptionalLoadAudio,
    OptionalLoadVideo,
)

NODE_CLASS_MAPPINGS = {
    "OptionalLoadImage": OptionalLoadImage,    
    "OptionalLoadAudio": OptionalLoadAudio,  
    "OptionalLoadVideo": OptionalLoadVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OptionalLoadImage": "Optional Load Image (None支持)",
    "OptionalLoadAudio": "Optional Load Audio (None支持)",
    "OptionalLoadVideo": "Optional Load Video (None支持)",
}

__version__ = "1.0.1"
__author__ = "Custom"

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
