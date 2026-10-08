// Optional Media Loaders 前端扩展（参考 VHS 的 addUploadWidget / addVideoPreview 实现）
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

// 上传文件到 ComfyUI input 目录（标准 /upload/image 接口）
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

// 给下拉 widget 添加 "choose video to upload" 上传按钮（对标 VHS addUploadWidget）
function addUploadWidget(nodeType, widgetName, type = "video") {
    const accept = {
        'video': ["video/webm", "video/mp4", "video/x-matroska", "image/gif"],
        'audio': ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg"],
    }[type]
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        const node = this
        const pathWidget = this.widgets.find((w) => w.name === widgetName);
        const fileInput = document.createElement("input");
        chainCallback(this, "onRemoved", () => {
            fileInput?.remove();
        });

        async function doUpload(file) {
            let resp = await uploadFile(file, (p) => node.progress = p)
            node.progress = undefined
            if (resp.status != 200) {
                return false
            }
            const filename = JSON.parse(resp.responseText).name;
            // 上传成功后把文件加入下拉列表并选中（保留首个 None 选项）
            if (!pathWidget.options.values.includes(filename)) {
                pathWidget.options.values.push(filename);
            }
            pathWidget.value = filename;
            if (pathWidget.callback) {
                pathWidget.callback(filename)
            }
            return true
        }

        Object.assign(fileInput, {
            type: "file",
            accept: accept.join(','),
            style: "display: none",
            onchange: async () => {
                if (fileInput.files.length) {
                    return await doUpload(fileInput.files[0])
                }
            },
        });
        this.onDragOver = (e) => !!e?.dataTransfer?.types?.includes?.('Files')
        this.onDragDrop = async function (e) {
            if (!e?.dataTransfer?.types?.includes?.('Files')) {
                return false
            }
            const item = e.dataTransfer?.files?.[0]
            if (accept.includes(item?.type)) {
                return await doUpload(item)
            }
            return false
        }

        document.body.append(fileInput);
        let uploadWidget = this.addWidget("button", "choose " + type + " to upload", "image", () => {
            app.canvas.node_widget = null
            fileInput.click();
        });
        uploadWidget.options.serialize = false;
    });
}

// 轻量视频预览：用浏览器原生 video 播放 input 目录下选中的视频（不依赖 VHS 后端）
// 下拉选 "None" 时自动隐藏预览
function addVideoPreview(nodeType, widgetName = "video") {
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
        if (nodeData.name === "OptionalLoadVideo") {
            addUploadWidget(nodeType, "video", "video");
            addVideoPreview(nodeType, "video");
        }
    },
});
