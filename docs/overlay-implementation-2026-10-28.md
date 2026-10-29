# 悬浮同传实现与实测记录

日期：2026-10-28 至 2026-10-29。平台：Windows，Electron 45.1.0。模型沿用已验证的 `qwen3.8-livetranslate-flash-realtime` 和原 API Key，本轮没有变更凭据。

## 交付行为

主页新增“悬浮窗功能”，默认开启电脑声音采集，源语言由模型自动处理，输出语言默认为中文。普通同传页也增加“悬浮窗”按钮：已有会话进入时保留采集源、目标语言、热词、笔记、模型连接和字幕。媒体准备成功并显示悬浮窗以后，才销毁可见主窗口；准备失败会保留主窗口并显示原因。

标准窗提供置顶、标题栏拖动、透明度、收音暂停/恢复、目标语言、TTS 开关与音量、字幕隐藏、小球和退出。右上角“返回”只关闭悬浮界面并恢复进入前的主页面，媒体宿主、模型连接、采集和播报继续运行；系统关闭悬浮窗也走同一条返回路径。独立的“退出同传”按钮才会保存尾段、停止媒体链路并退出应用。标准窗与小球分别记忆位置，屏幕变化时把窗口夹回当前工作区。透明度只改变背景，文字保持清晰。隐藏字幕后收成紧凑音频控制条，采集和播报继续工作。

悬浮窗的音量控件明确标注了方向：译音播报滑块左侧是“小声”、右侧是“大声”，并显示百分比；透明度滑块左侧是“遮挡较少”、右侧是“更清晰”。当前系统原声仍由 Windows 音量混合器控制，界面不把它伪装成可调的“原声比例”；真正的原声/译音混音会随着虚拟声卡输出链路一起实现。

缩小为小球复用同一个悬浮窗口和媒体会话，不导航页面、不重建 WebSocket。小球支持拖动，超过 5px 的拖动不会被当作点击；单击恢复标准窗。恢复时读取标准窗自己的位置。

字幕界面缓存最近 4 组，原文在上、译文在下，显示模型返回的说话人编号。空间不足时从最旧一组开始整组隐藏，避免只显示半句；长句分别限制可见行数，完整内容仍会保存并可复制。长按 600ms 复制当时的原译文配对，即使字幕继续更新也不改变复制对象；同时支持右键和键盘复制。没有历史翻页或点击重播。

![标准悬浮窗](images/overlay-standard-live.png)

## 生命周期与职责

`app/js/media-session.js` 是唯一的采集、模型会话和实时播报控制器，由隐藏的 `media-host.html` 持有。普通页面与悬浮窗通过固定 IPC 命令和快照接入它。

`electron/main.js` 管理窗口、权限、位置与有序退出；`electron/service.js` 继续由 Electron utility process 托管，处理本地 HTTP/WS、模型网关与 SQLite/WAV。AudioWorklet 与音频播放留在媒体 renderer，以使用 Chromium 的媒体能力。可见 UI 不持有采集轨道或模型 WebSocket。

`UI → 受控 IPC → 隐藏媒体宿主 → 本地 WebSocket → Node 网关 → Qwen`

媒体宿主直接把 16 kHz PCM 发给本地服务，音频帧不绕可见窗口或主进程 IPC。可见窗口只接收字幕、状态和节流后的音量/计时。进入悬浮模式、隐藏字幕、缩成小球均不会创建第二条音频上传链路。

运行中阻止应用挂起；媒体宿主和悬浮页关闭后台节流。暂停会停止并释放输入轨道和播放队列，恢复时重新采集并沿用原模型会话。模型仍可能在暂停后补齐尾段，这些结果继续写入数据库。

“退出”流程为：停止采集/播放 → 刷新笔记 → 请求模型结束 → 等待 `session.finished` 和 WAV/数据库收尾 → 关闭网关 → 销毁悬浮窗、媒体宿主和其他窗口 → 退出应用。退出过程展示保存状态，避免把小球与退出混用。宿主崩溃会通知用户并协调后台保存。

## 系统采集与 TTS 隔离

实际请求：

~~~js
navigator.mediaDevices.getDisplayMedia({
  audio: {
    restrictOwnAudio: true,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  video: true,
});
~~~

Electron 的 display-media handler 为受信任页面选择屏幕，并提供 `audio: 'loopback'`。确认拿到音轨后立即停止视频轨道，后续只处理音频。麦克风采集仍使用适合麦克风的回声消除、降噪和自动增益配置。

Electron 45.1.0 的实现会在 `request.restrict_own_audio` 为真时，把 Windows loopback 切为 `loopbackWithoutChrome`，排除本应用输出。实际轨道设置返回：

~~~json
{
  "deviceId": "loopbackWithoutChrome",
  "restrictOwnAudio": true,
  "echoCancellation": false,
  "noiseSuppression": false,
  "autoGainControl": false,
  "sampleRate": 48000,
  "channelCount": 2
}
~~~

采集 Worklet 再转换为单声道 16 kHz、每帧 320 samples 的 PCM。实时 TTS 为 24 kHz，通过播放器 GainNode 单独调节，开关关闭时清空播放队列，字幕、上行音频和译音文件保存继续运行。重新打开只播放之后收到的音频，不积压重播关闭期间的内容。

系统输入实时播放同时受 Windows 能力与实际轨道 `restrictOwnAudio` 确认约束。能力不足时显示原因并保留译音文件；麦克风会话按自身播放条件运行。普通页创建的纯文字会话进入悬浮模式仍保持原请求模态，界面明确显示本次会话仅输出文字。

## 目标语言、笔记和记录

切换目标语言会先完整结束旧会话，再用新的 `translation.language` 创建会话。界面在等待期间禁用冲突操作，成功后更新标签；旧会话继续留在记录管理中。暂停状态与 TTS 播放偏好在切换后保持。此行为没有把本地标签变化伪装为模型已更新配置。

笔记输入立即送到媒体宿主暂存，后台防抖 500ms 写入数据库；离开主页面或退出时立即确认最后一次草稿，避免页面被销毁后丢失未触发的计时器。首次开始前填写的笔记也会保留。数据库依然保存全部字幕和音频，悬浮界面只保留显示所需的最近 4 组。

## 对原需求的调整

- Windows 普通桌面程序没有 Android 式的独立“悬浮窗显示权限”。使用原生置顶窗口；收音实际失败时提供设置引导，设置按钮也可打开 Windows 隐私设置。
- 原声外放属于其他应用/系统的输出。调节采集流的 Gain 并不能调节那些应用的外放音量。这版提供“原声由系统控制”的音量混合器入口，译音拥有真实独立的开关和音量。原声归零但保留捕获与译音的统一控制，需要后续音频路由能力。
- 悬浮窗独立于可见主窗口，但仍由 Electron 应用主进程管理。应用正常退出或进程被终止后，窗口不会作为另一个常驻程序继续运行。
- 置顶用于普通桌面和可覆盖的无边框窗口；独占全屏游戏、系统安全桌面不属于普通置顶窗口可保证覆盖的范围。
- 说话人编号是模型当前会话返回的区分结果，不是跨会话的实名声纹身份库。

## 验证及原始证据

`npm test`：24/24 通过，覆盖媒体命令顺序、暂停释放、UI 重附着、TTS 独立开关、语言切换、异常清理、退出前笔记刷新、窗口偏好，以及原有网关/数据库/归段测试。

| 验证 | 命令 | 证据 |
| --- | --- | --- |
| 原生窗口和完整收尾 | `npm run verify:overlay` | `data/probes/overlay-verification.json` |
| 系统音频格式与释放 | `npm run verify:capture` | `data/probes/system-capture.json` |
| 自身音频排除、TTS 音量 | `npm run verify:loopback` | `data/probes/loopback-isolation.json` |
| 真实模型端到端 | `npm run verify:live -- <16k-mono-pcm-or-wav>` | `data/probes/overlay-live.json` |
| 真实会话 WAV 文件头与时长 | 文件检查 | `data/probes/overlay-media-files.json` |
| 主页与最小字幕窗布局 | Ego browser / 原生 Electron | `data/probes/overlay-browser-layout.json`、截图 |

回采隔离实测：同一应用播放 997 Hz 测试音，普通 loopback 幅度约 `0.03689`，自身排除后的幅度 `0`。播放器音量实测：满音量幅度 `0.03532`，20% 音量为 `0.00721`，比值 `0.2040`；静音后约 `2.55e-8`。这些是该设备该次测试的观测值。

原生生命周期实测覆盖主窗口确实销毁、同一 session_id 下持续上传、标准/小球独立位置恢复、隐藏字幕、收音暂停释放、目标语言重连、笔记保存与退出尾句写入。真实 Qwen 测试使用合成双说话人录音作为虚拟输入，经实际 AudioWorklet、Node 网关和模型；热词 `七牛灵矽 → Qiniu Xrobot`、两个说话人、最后一句 `Thank you.`、原音和译音文件均检查。

当前执行环境的系统剪贴板不可用：Electron 和 PowerShell 写入固定测试文字后都读回空值。已验证长按携带正确的原译文调用桥接，以及失败显示。复制接口会在写入后读回确认；系统未接受时显示错误，不显示“已复制”。此环境无法给出成功写入系统剪贴板的实测结论。

原生窗口和真实模型验证均使用独立的 `data/probes/` 数据目录与测试 userData，不混入正式会话库。音频隔离测试只分析测试音的幅度；系统采集检查只统计帧，不保存或上传桌面录音。真实模型验证上传的是指定合成测试录音。

## 官方实现参考

- Electron 45.1.0 的 [display-media 设备选择实现](https://github.com/electron/electron/blob/v45.1.0/shell/browser/electron_browser_context.cc)：`restrict_own_audio` 到 `kLoopbackWithoutChromeId`。
- Electron [session API](https://www.electronjs.org/docs/latest/api/session)：display-media request handler、loopback、权限处理。
- Electron [BrowserWindow API](https://www.electronjs.org/docs/latest/api/browser-window)：透明窗、置顶、后台节流。
- Electron 45.1.0 [Clipboard API](https://github.com/electron/electron/blob/v45.1.0/docs/api/clipboard.md)：异步读写与确认。
