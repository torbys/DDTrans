# Windows 虚拟声卡评估与实施顺序

日期：2026-10-29。范围：让 DDTrans 的混合音频出现在 Windows 的麦克风列表中，供游戏、会议和录音软件选择。

## 结论

技术上可行，但 Electron、Node.js、Web Audio 或 WebSocket 本身都不能注册一个新的 Windows 麦克风设备。要让其他程序看到 `DDTrans Virtual Microphone`，必须安装一个系统级虚拟音频设备，至少提供一个虚拟 Capture Endpoint；应用再把原声和译音混合后的 PCM 写入这个端点。

当前项目的 `getDisplayMedia({ audio: ... })` 只能采集电脑声音，`AudioContext` 的 `sinkId` 只能选择译音播放到哪个已有的输出设备。这两项能力都不能替代虚拟 Capture Endpoint，所以不能只靠修改 `.env`、IPC 或前端页面完成虚拟声卡。

## 当前进度（2026-10-29 本轮实现后）

下文保留本轮实现前的评估正文，便于追溯当时的设计边界；其中“当前代码离目标还差什么”和“实施顺序”的应用侧前置项已有进展。现在已具备 48 kHz 真实混音总线、原声/译音独立增益、默认译音监听和可选混合预听、独立 Render Endpoint 输出、设置即时生效与原子保存。Worklet 逐采样限幅并记录真实峰值/限幅计数，TTS 队列上限为 10 秒。

这些能力只接入既有 Windows 播放设备。本机探针没有发现虚拟输入或输出设备，因此没有建立 `DDTrans Virtual Microphone`，也没有完成 Teams、Discord、游戏或录音软件从配对 Capture Endpoint 接收混音的实测。设备延迟当前只显示打开输出 `AudioContext` 的 `baseLatency + outputLatency` 估计，不是端到端延迟；没有虚构欠载指标。

正式 Windows 自有驱动、签名、安装、卸载、升级和休眠恢复仍按下文第二步执行，不能由 Electron、Web Audio 或应用侧路由替代。

## 推荐的最小架构

```text
电脑声音 / 麦克风
        ↓
DDTrans 采集与重采样（16 kHz）
        ├──→ 实时翻译 → TTS PCM（24 kHz）
        ↓                         ↓
        └──────→ 混音总线 ←────────┘
                   │
       原声 Gain / 译音 Gain / TTS 开关 / 限幅
                   ↓
       用户态音频桥接（WASAPI 或共享内存环形缓冲）
                   ↓
       DDTrans Virtual Microphone（Capture Endpoint）
                   ↓
       游戏 / 会议 / 录音软件的麦克风选择器
```

第一版只需要虚拟麦克风端点。虚拟扬声器端点可以作为后续的监听、回放和音频路由能力加入，不应在第一版同时承担所有系统音频职责。

## 当前代码离目标还差什么

当前 `app/js/audio-capture.js` 已经把系统声音和麦克风混成一个 `MediaStream`，并用 AudioWorklet 重采样为 16 kHz PCM；`app/js/audio-engine.js` 负责 24 kHz TTS 播放和译音 Gain。这为混音总线提供了基础，但现在的采集链路主要把 PCM 送给翻译会话，TTS 直接送到普通播放输出，还没有一个同时接收“原声 PCM + TTS PCM”并写入系统 Capture Endpoint 的输出通道。

因此虚拟声卡开发需要先做一次音频链路整理：把“送模型”和“送虚拟设备”作为同一份输入的两个消费者；把原声增益、译音增益和 TTS 开关放在虚拟输出混音总线；保留本地监听作为另一条输出路径。这样设置页里的“原声音量”和“译音音量”才有真实含义。

这里要区分两个结果：调低虚拟麦克风里的原声，只会改变游戏或会议收到的 DDTrans 音频；它不会自动把其他应用在本地扬声器上播放的原声静音。若以后需要本地原声也随比例变化，必须再接 Windows 音量会话控制或把本地监听统一改为 DDTrans 的输出路由。

## 实施顺序

### 1. 先做路由证明，不立即写驱动

用一个已存在的 Windows 虚拟音频线缆或测试驱动验证混音总线：DDTrans 把混音输出到虚拟线缆的 Render Endpoint，Teams、Discord 或测试录音程序从对应的 Capture Endpoint 录音。验收原声增益、译音增益、TTS 开关、目标语言切换、暂停恢复和 100 ms 级别的延迟预算。

这一步只验证 DDTrans 的音频数据和用户交互，不把第三方驱动作为最终产品依赖。若没有稳定的混音输出和延迟测量，直接写驱动会把音频问题和驱动问题混在一起。

### 2. 再做 Windows 虚拟设备

生产版本应基于 Windows 音频虚拟设备的驱动模型和 SysVAD 示例，提供 `DDTrans Virtual Microphone`。驱动安装器需要覆盖设备安装、卸载、升级、驱动签名、权限、休眠恢复、采样率和共享模式验证。驱动与应用之间使用固定格式的 PCM 和有界环形缓冲，避免把实时音频通过 Electron IPC 逐帧传输。

### 3. 接入应用层

应用侧增加一个独立的音频桥接组件，职责只有三件事：接收混音总线的 PCM、把数据写入虚拟设备、暴露设备状态和缓冲延迟。主页面和悬浮窗只通过现有媒体宿主读取状态，不直接操作驱动。

设置页第一版提供：

- 虚拟麦克风状态和“一键测试”；
- 发送到虚拟麦克风的原声音量；
- 发送到虚拟麦克风的译音音量；
- TTS 播报开关与音量；
- 本地监听设备和监听音量；
- 当前采样率、缓冲区和估算延迟。

“变声”单独处理。TTS 音色可以在确认模型支持的 voice 列表后加入；把用户原声实时变成另一种音色则需要额外的语音转换或 DSP 链路，不能由虚拟声卡驱动本身提供。

## 暂时不应做的事情

- 不为了虚拟声卡现在就把当前稳定的 WebSocket 网关改成 WebRTC 或 AOQ。
- 不把驱动、音频桥接、翻译会话和数据库写入塞进 Electron 主进程。
- 不先实现“原声比例”这个没有明确输出边界的控件；它应明确表示“发送到虚拟麦克风的原声增益”。
- 不把实时变声和 TTS 音色选择混成同一项设置。

## 验收指标

第一版需要同时记录：设备出现时间、设备被其他应用打开的成功率、混音端到端延迟、缓冲欠载次数、设备被占用时的错误、暂停/恢复后的音频连续性，以及退出应用后设备是否仍正确释放。真实会议软件和至少一个游戏内语音设置都要完成一次选择、讲话、录音回放验证。

## 参考资料

- [Microsoft：Virtual Audio Devices](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/virtual-audio-devices)
- [Microsoft：SysVAD Virtual Audio Device Driver Sample](https://github.com/microsoft/Windows-driver-samples/tree/main/audio/sysvad)
- [Microsoft：Application Loopback API](https://learn.microsoft.com/en-us/windows/win32/coreaudio/application-loopback)
- [Microsoft：Driver Signing](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/driver-signing)
- [W3C：AudioContext `sinkId`](https://www.w3.org/TR/webaudio/#dom-audiocontext-sinkid)
