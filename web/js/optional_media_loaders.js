// Optional Media Loaders 前端扩展
// 为 Image / Audio / Video 三个可选加载节点补充：
//   1) 点击「choose ... to upload」按钮，弹出文件选择框加载本地媒体到 input 目录
//   2) 拖拽文件到节点直接上传
//   3) 选中资源后的可视化预览（图片 / 音频播放器 / 视频预览）
//
// 【多节点兼容】对齐 ComfyUI 官方 LoadImage 的做法：每个媒体类型只创建一个
//   全局共享的隐藏 fileInput，点击哪个节点的按钮就把"当前上传目标"指向该节点，
//   从而避免多个同类节点各自建 fileInput 导致的互相干扰（一个加载完另一个不能用）。
import { app } from '../../../scripts/app.js'
import { api } from '../../../scripts/api.js'

function chainCallback(object, property, callback) {
    if (object == undefined) {
        console.error("[OptionalMediaLoaders] Tried to add callback to non-existant object")
        return;
    }
    if (property in object && object[property]) {
        const callback_orig = object[property]
        object[property] = function () {
            const r = callback_orig.apply(this, arguments);
            return callback.apply(this, arguments) ?? r
        };
    } else {
        object[property] = callback;
    }
}

// 上传文件到 ComfyUI input 目录（标准 /upload/image 接口，对任意媒体类型通用）
async function uploadFile(file, progressCallback) {
    const body = new FormData();
    const i = file.webkitRelativePath ? file.webkitRelativePath.lastIndexOf('/') : -1;
    const subfolder = i > 0 ? file.webkitRelativePath.slice(0, i + 1) : '';
    const new_file = new File([file], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    });
    body.append("image", new_file);
    if (i > 0) {
        body.append("subfolder", subfolder);
    }
    const url = api.apiURL("/upload/image")
    const resp = await new Promise((resolve) => {
        let req = new XMLHttpRequest()
        req.upload.onprogress = (e) => progressCallback?.(e.loaded / e.total)
        req.onload = () => resolve(req)
        req.open('post', url, true)
        if (typeof getAuthHeader === 'function') {
            getAuthHeader().then((headers) => {
                headers ??= {}
                for (const key in headers)
                    req.setRequestHeader(key, headers[key])
                req.send(body)
            })
        } else {
            req.send(body)
        }
    })
    if (resp.status !== 200) {
        alert(resp.status + " - " + resp.statusText);
    }
    return resp
}

// 各媒体类型的可接受文件类型（用于 <input accept> 与拖拽校验）
const ACCEPT_MAP = {
    'image': ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"],
    'audio': ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac", "audio/ogg"],
    'video': ["video/webm", "video/mp4", "video/x-matroska", "video/quicktime", "image/gif"],
};

// ===== 每个媒体类型一个全局共享 fileInput，避免多节点各自建 fileInput 互相冲突 =====
const sharedInputs = {};   // type -> input element
const uploadTargets = {};  // type -> { node, widgetName }（当前点击按钮的节点）

function getSharedInput(type) {
    if (!sharedInputs[type]) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ACCEPT_MAP[type].join(',');
        input.style.display = "none";
        input.onchange = async () => {
            const target = uploadTargets[type];
            uploadTargets[type] = null;   // 只处理一次
            if (target && input.files.length) {
                await doUploadForNode(target.node, target.widgetName, input.files[0], type);
            }
            input.value = "";  // 重置，允许下次再次选择同一文件
        };
        document.body.append(input);
        sharedInputs[type] = input;
    }
    return sharedInputs[type];
}

// 上传成功后的公共处理：把文件加入目标节点的下拉列表并选中（保留首个 None 选项）
async function doUploadForNode(node, widgetName, file, type) {
    let resp = await uploadFile(file, (p) => node.progress = p)
    node.progress = undefined
    if (resp.status != 200) {
        return false
    }
    const filename = JSON.parse(resp.responseText).name;
    const pathWidget = node.widgets?.find((w) => w.name === widgetName);
    if (pathWidget) {
        if (!pathWidget.options.values.includes(filename)) {
            pathWidget.options.values.push(filename);
        }
        pathWidget.value = filename;
        if (pathWidget.callback) {
            pathWidget.callback(filename)
        }
    }
    return true
}

// 给下拉 widget 添加 "choose ... to upload" 加载按钮 + 拖拽上传
// nodeType 标记防止前端重复加载时对同一节点类叠加多个按钮
function addUploadWidget(nodeType, widgetName, type = "video") {
    if (nodeType.prototype.__optMediaUploadAdded) return;
    nodeType.prototype.__optMediaUploadAdded = true;

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        const node = this;
        const input = getSharedInput(type);

        this.onDragOver = (e) => !!e?.dataTransfer?.types?.includes?.('Files')
        this.onDragDrop = async function (e) {
            if (!e?.dataTransfer?.types?.includes?.('Files')) {
                return false
            }
            const item = e.dataTransfer?.files?.[0]
            if (ACCEPT_MAP[type].includes(item?.type)) {
                return await doUploadForNode(node, widgetName, item, type)
            }
            return false
        }

        this.addWidget("button", "choose " + type + " to upload", "image", () => {
            app.canvas.node_widget = null
            uploadTargets[type] = { node, widgetName };
            input.value = "";   // 重置，保证每次都能弹出选择框
            input.click();
        }).options.serialize = false;
    });
}

// 图片预览：下拉选中的 input 目录图片用 <img> 展示，选 "None" 时隐藏
function addImagePreview(nodeType, widgetName = "image") {
    if (nodeType.prototype.__optMediaImagePreviewAdded) return;
    nodeType.prototype.__optMediaImagePreviewAdded = true;

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        const previewNode = this;
        const element = document.createElement("div");
        element.style.width = "100%";
        const imgEl = document.createElement("img");
        imgEl.style.width = "100%";
        imgEl.style.display = "block";
        element.appendChild(imgEl);

        let previewWidget = this.addDOMWidget("imagepreview", "preview", element, {
            serialize: false,
        });
        previewWidget.computeSize = function (width) {
            if (imgEl.naturalWidth && imgEl.naturalHeight) {
                return [width, Math.min(width * imgEl.naturalHeight / imgEl.naturalWidth, 512)];
            }
            return [width, 0];
        };

        function updatePreview() {
            const val = previewNode.widgets.find((w) => w.name === widgetName)?.value;
            if (!val || val === "None") {
                imgEl.removeAttribute('src');
                element.style.display = "none";
            } else {
                element.style.display = "";
                imgEl.src = api.apiURL("/view?type=input&filename=" + encodeURIComponent(val));
            }
            previewNode.setSize(previewNode.computeSize());
        }
        imgEl.onload = updatePreview;
        imgEl.onerror = updatePreview;
        chainCallback(previewNode.widgets.find((w) => w.name === widgetName), "callback", updatePreview);
        // 节点创建后延迟初始化预览
        setTimeout(updatePreview, 100);
    });
}

// 音频预览：下拉选中的 input 目录音频用原生 <audio> 播放器展示
function addAudioPreview(nodeType, widgetName = "audio") {
    if (nodeType.prototype.__optMediaAudioPreviewAdded) return;
    nodeType.prototype.__optMediaAudioPreviewAdded = true;

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        const previewNode = this;
        const element = document.createElement("div");
        element.style.width = "100%";
        const audioEl = document.createElement("audio");
        audioEl.controls = true;
        audioEl.preload = "metadata";
        audioEl.style.width = "100%";
        audioEl.style.display = "block";
        element.appendChild(audioEl);

        let previewWidget = this.addDOMWidget("audiopreview", "preview", element, {
            serialize: false,
        });
        previewWidget.computeSize = function (width) {
            return [width, 36];
        };

        function updatePreview() {
            const val = previewNode.widgets.find((w) => w.name === widgetName)?.value;
            if (!val || val === "None") {
                audioEl.pause();
                audioEl.removeAttribute('src');
                audioEl.load();
                element.style.display = "none";
            } else {
                element.style.display = "";
                audioEl.src = api.apiURL("/view?type=input&filename=" + encodeURIComponent(val));
            }
            previewNode.setSize(previewNode.computeSize());
        }
        chainCallback(previewNode.widgets.find((w) => w.name === widgetName), "callback", updatePreview);
        // 节点创建后延迟初始化预览
        setTimeout(updatePreview, 100);
    });
}

// 轻量视频预览：用浏览器原生 video 播放 input 目录下选中的视频（不依赖 VHS 后端）
// 下拉选 "None" 时自动隐藏预览
function addVideoPreview(nodeType, widgetName = "video") {
    if (nodeType.prototype.__optMediaVideoPreviewAdded) return;
    nodeType.prototype.__optMediaVideoPreviewAdded = true;

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        const previewNode = this;
        const element = document.createElement("div");
        element.style.width = "100%";
        const videoEl = document.createElement("video");
        videoEl.controls = false;
        videoEl.loop = true;
        videoEl.muted = true;
        videoEl.style.width = "100%";
        videoEl.style.display = "block";
        element.appendChild(videoEl);

        let previewWidget = this.addDOMWidget("videopreview", "preview", element, {
            serialize: false,
        });
        previewWidget.computeSize = function (width) {
            const h = videoEl.videoHeight ? width / (videoEl.videoWidth / videoEl.videoHeight) : 0;
            return [width, h];
        };

        function updatePreview() {
            const video = previewNode.widgets.find((w) => w.name === widgetName)?.value;
            if (!video || video === "None") {
                videoEl.pause();
                videoEl.removeAttribute('src');
                videoEl.load();
                element.style.display = "none";
            } else {
                element.style.display = "";
                videoEl.src = api.apiURL("/view?type=input&filename=" + encodeURIComponent(video));
                videoEl.play();
            }
            previewNode.setSize(previewNode.computeSize());
        }
        chainCallback(previewNode.widgets.find((w) => w.name === widgetName), "callback", updatePreview);
        // 节点创建后延迟初始化预览
        setTimeout(updatePreview, 100);
    });
}

app.registerExtension({
    name: "OptionalMediaLoaders",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "OptionalLoadImage") {
            addUploadWidget(nodeType, "image", "image");
            addImagePreview(nodeType, "image");
        } else if (nodeData.name === "OptionalLoadAudio") {
            addUploadWidget(nodeType, "audio", "audio");
            addAudioPreview(nodeType, "audio");
        } else if (nodeData.name === "OptionalLoadVideo") {
            addUploadWidget(nodeType, "video", "video");
            addVideoPreview(nodeType, "video");
        }
    },
});
