import os
import folder_paths
import torch
import numpy as np
from PIL import Image, ImageOps
import soundfile as sf
import cv2

# ====================== 工具函数：直接读取input物理目录，规避 folder_paths KeyError（对标ViewComfy实现） ======================
def get_input_files(extensions):
    input_dir = folder_paths.get_input_directory()
    try:
        all_files = []
        for fname in os.listdir(input_dir):
            full_path = os.path.join(input_dir, fname)
            if os.path.isfile(full_path):
                ext = os.path.splitext(fname)[1].lower()
                if ext in extensions:
                    all_files.append(fname)
        return sorted(all_files)
    except Exception:
        return []

def get_image_combo_list():
    img_exts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]
    return ["None"] + get_input_files(img_exts)

def get_audio_combo_list():
    aud_exts = [".wav", ".flac", ".mp3", ".ogg"]
    return ["None"] + get_input_files(aud_exts)

def get_video_combo_list():
    vid_exts = [".webm", ".mp4", ".mkv", ".gif", ".mov"]
    # 首项固定为 None（默认不传视频），后接 input 目录下的视频资源列表
    return ["None"] + get_input_files(vid_exts)


# ===================== OptionalLoadImage 对标 ViewComfy LoadImage，带MASK输出 =====================
class OptionalLoadImage:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": (get_image_combo_list(),),
            }
        }
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load_image"
    CATEGORY = "media/optional_loaders"

    def load_image(self, image):
        if image == "None":
            return (None, None)
        image_path = os.path.join(folder_paths.get_input_directory(), image)
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)
        if img.mode == "RGBA":
            mask = np.array(img.split()[-1]).astype(np.float32)/255.0
            img = img.convert("RGB")
        else:
            mask = np.zeros(img.size[::-1], dtype=np.float32)
        img_np = np.array(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_np)[None, ...]
        mask_tensor = torch.from_numpy(mask)[None, ...]
        return (img_tensor, mask_tensor)


# ===================== OptionalLoadAudio =====================
class OptionalLoadAudio:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "audio": (get_audio_combo_list(),),
            }
        }
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "load_audio"
    CATEGORY = "media/optional_loaders"

    def load_audio(self, audio):
        if audio == "None":
            return (None,)
        audio_path = os.path.join(folder_paths.get_input_directory(), audio)
        data, sample_rate = sf.read(audio_path)
        if len(data.shape) == 1:
            data = np.expand_dims(data, axis=1)
        waveform = torch.from_numpy(data.T).float().unsqueeze(0)
        audio_dict = {"waveform": waveform, "sample_rate": sample_rate}
        return (audio_dict,)


# ===================== OptionalLoadVideo 对标 VHS LoadVideo，下拉列表 + None 默认 + 上传/预览（前端JS） =====================
class OptionalLoadVideo:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # 下拉资源列表，首项 "None" 为默认（不传视频）；上传/预览由前端 JS 提供
                "video": (get_video_combo_list(),),
            },
            "optional": {
                "force_rate": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 60.0, "step": 1.0}),
                "custom_width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8}),
                "custom_height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8}),
                "frame_load_cap": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "select_every_nth": ("INT", {"default": 1, "min": 1, "max": 1000, "step": 1}),
            },
        }
    RETURN_TYPES = ("IMAGE", "INT", "AUDIO", "VHS_VIDEOINFO")
    RETURN_NAMES = ("IMAGE", "frame_count", "audio", "video_info")
    FUNCTION = "load_video"
    CATEGORY = "media/optional_loaders"

    def load_video(self, video, force_rate=0.0, custom_width=0, custom_height=0,
                   frame_load_cap=0, skip_first_frames=0, select_every_nth=1):
        # 默认 "None"（未传视频）：返回空输出，四路与原型一致
        if video is None or video == "None":
            return (None, 0, None, None)

        video_path = os.path.join(folder_paths.get_input_directory(), video)
        if not os.path.isfile(video_path):
            raise RuntimeError(f"Video file not found: {video}")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video}")

        # 读取元信息
        source_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        source_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        source_duration = source_total / source_fps if source_fps > 0 else 0.0

        # 目标帧率重采样间隔（force_rate=0 时保持原始帧率）
        base_frame_time = 1.0 / source_fps if source_fps > 0 else 1.0
        target_frame_time = base_frame_time if force_rate == 0 else 1.0 / force_rate

        # 纯 read() 逐帧 + 时间戳选帧（不依赖 grab/retrieve 指针状态，避免 retrieve 取不到帧的问题）
        frames = []
        target_time = 0.0          # 下一个采样时间点（秒）
        frame_index = 0            # 原始帧序号
        capture_count = 0          # 达到采样点、进入取帧处理的帧数（含被 skip 的）
        frames_evaluated = -1      # skip 之后、select 之前的计数
        use_timestamps = source_fps > 0 and force_rate != 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_time = frame_index / source_fps if source_fps > 0 else frame_index
            if not use_timestamps or frame_time >= target_time - 1e-9:
                capture_count += 1
                if capture_count > skip_first_frames:
                    frames_evaluated += 1
                    if select_every_nth <= 1 or frames_evaluated % select_every_nth == 0:
                        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        frames.append(frame)
                        if frame_load_cap > 0 and len(frames) >= frame_load_cap:
                            break
                if use_timestamps:
                    target_time += target_frame_time
            frame_index += 1
        cap.release()

        if not frames:
            raise RuntimeError(f"No frames loaded from video: {video}")

        # 组装 IMAGE tensor (N, H, W, 3)
        arr = np.stack(frames).astype(np.float32) / 255.0
        image = torch.from_numpy(arr)

        # 可选缩放（custom_width / custom_height，任一非0则等比例/指定缩放）
        if custom_width != 0 or custom_height != 0:
            if custom_width == 0:
                custom_width = int(custom_height * source_width / source_height)
            elif custom_height == 0:
                custom_height = int(custom_width * source_height / source_width)
            custom_width = max(8, int(custom_width / 8 + 0.5) * 8)
            custom_height = max(8, int(custom_height / 8 + 0.5) * 8)
            image = image.permute(0, 3, 1, 2)  # (N,C,H,W)
            image = torch.nn.functional.interpolate(
                image, size=(custom_height, custom_width), mode="bilinear", align_corners=False)
            image = image.permute(0, 2, 3, 1)  # (N,H,W,C)

        # 实际输出帧率：考虑 force_rate 与 select_every_nth 共同作用
        effective_target = target_frame_time * select_every_nth
        loaded_fps = 1.0 / effective_target if effective_target > 0 else 0.0
        video_info = {
            "source_fps": source_fps,
            "source_frame_count": source_total,
            "source_duration": source_duration,
            "source_width": source_width,
            "source_height": source_height,
            "loaded_fps": loaded_fps,
            "loaded_frame_count": image.shape[0],
            "loaded_duration": image.shape[0] / loaded_fps if loaded_fps > 0 else 0.0,
            "loaded_width": image.shape[2],
            "loaded_height": image.shape[1],
        }
        # 不提取音轨（音频请用 OptionalLoadAudio 单独加载）
        return (image, image.shape[0], None, video_info)


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
