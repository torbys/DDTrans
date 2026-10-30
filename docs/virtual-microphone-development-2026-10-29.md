# DDTrans 自有虚拟麦克风开发记录

> 2026-10-30 更新：安装路线已改为随 DDTrans EXE 集成原厂签名的 VB-CABLE，不再要求用户安排测试签名环境。当前实现与验收见 [Windows 安装方案](windows-installer-virtual-audio-2026-10-30.md)。以下保留当时的开发记录。

日期：2026-10-29。范围：Windows 11 x64，自有最小 Render/Capture 驱动、设置页发言翻译、可重复的构建与验证。

## 当前交付状态

源码已实现并编译出内核驱动及原生工具；INF 与目录生成检查通过。音频桥有离线参考模型测试。主机尚未安装或加载驱动，尚不能宣称外部会议能从 DDTrans Virtual Microphone 收到声音。实际安装、加载及外部收音是下一步，需要先确定签名测试环境。

编译与应用开发可以在当前主机完成，不需要重启。只有进入本地测试签名的启动配置或 Windows 明确报告安装后重启时才需要通知用户。简单重启当前电脑不会自动增加设备。

## 数据路径

实体麦克风 → 同一媒体宿主识别/翻译/TTS → 48 kHz 混音 → DDTrans Virtual Input（Render） → 驱动音频桥 → DDTrans Virtual Microphone（Capture） → 会议或游戏。

- 源语言由现有模型自动识别；驱动不参与模型协议。
- 播放和录音端的硬件格式一致：48 kHz、单声道、16 位 PCM，支持 DEFAULT 与 RAW 信号处理模式。Windows 共享音频引擎负责客户端格式适配。
- 桥位于每个适配器的非分页内存中，以自旋锁保护，以最多两段连续内存复制搬运 PCM；固定 4800 个采样（100 ms）上限。满时丢最旧内容，欠载填零。
- 播放流停止、重新开始、采集流切换及设备电源变化会清理缓存；100 ms 没有新写入时清理旧内容。长时间调度中断最多处理一圈 DMA 缓冲，避免追放旧音频。
- 同一适配器只开放一个系统播放流和一个系统采集流；多个共享模式客户端由 Windows 音频引擎分发，不在驱动内重复实现混音器。
- 新代码使用结构与函数；PortCls/KMDF 的 COM 接口沿用官方样例必需的接口实现。

## 来源与改动

以 Microsoft Windows-driver-samples 中的 SimpleAudioSample 为基础，固定提交 d65f6bb4041fa74f969e78ce2cfc230a71e824b4。MIT 许可保留在 native/virtual-microphone/driver/LICENSE，来源记在 UPSTREAM.md。

替换了示例的正弦测试音和写磁盘路径，统一了原本不一致的播放/采集格式，加入有界 PCM 桥、DDTrans 设备身份和专属端点名称，并调整流销毁时的定时器回调停止顺序。Wave miniport 持有 adapter 强引用以保证缓冲寿命；启动失败回滚、power-management 注册/解除、端点安装失败传播和 DMA 映射失败也已补齐。驱动没有云端请求、私有实时 IOCTL、额外翻译服务或应用私有 PCM 写入器。

## 构建

需要已有 Visual Studio 2022 的 x64 C++ 工具和 Windows SDK 10.0.26100.0。当前主机已有这两项。额外 WDK 使用项目本地 NuGet 包，不运行全局安装器：下载 110872506 bytes，解压约 319 MB，SHA-256 固定在恢复脚本中。

从仓库根目录运行：

~~~powershell
npm run driver:restore
npm run driver:build
npm run driver:check
~~~

构建产物默认保存在 data/driver-development/build（Git 忽略）：

| 文件 | 用途 |
| --- | --- |
| package/DDTransVirtualAudio.sys | x64 内核音频驱动 |
| package/DDTransVirtualAudio.inf | ROOT\DDTransVirtualAudio、端点名称与 PortCls/KMDF 安装声明 |
| package/DDTransVirtualAudio.cat | Inf2Cat 为包生成的目录 |
| ddtrans-device-tool.exe | 原生端点/签名策略查询，以及显式安装、移除专属硬件 ID |
| ddtrans-probe.exe | 直接使用 WASAPI 从 Render 播放 997 Hz、从 Capture 收音并检查停止后的静音 |
| audio-ring-tests.exe | 可离线运行的音频缓冲参考模型测试 |

build.ps1 使用 /kernel、/W4 /WX、栈保护与 CFG。它会先运行缓冲测试，再编译驱动和原生工具，执行 InfVerif /w 与 Inf2Cat。输出成功不代表已通过内核运行、HLK、休眠/唤醒或会议兼容性测试。

~~~powershell
npm run driver:sign-dev
npm run driver:package
~~~

开发签名脚本在当前用户个人证书存储创建或复用 DDTrans Local Driver Development 代码签名证书，并签署 SYS 和 CAT。私钥不可导出；只导出公开 CER。它不把证书加入信任根、不修改测试签名或 Secure Boot、不安装设备、不重启。开发签名不等于 Microsoft 发布签名。打包脚本包含 SYS/INF/CAT、原生工具、安装脚本、公开 CER、MIT 许可和 SHA-256 清单；私钥不进入 ZIP。当前开发包为 data/driver-development/DDTrans-Virtual-Microphone-dev-x64.zip（222199 bytes），SHA-256 为 125c85b925d4291125dd39cf08ffee67363f97733a6058efd3fba6dcf3582b4a。

## 安装边界

install.ps1 默认仅检查。只有显式选择 Install/Remove 才修改设备，并要求管理员权限。开发包遇到 Secure Boot 开启或测试签名未生效时拒绝安装；没有可信签名时也不会先创建占位设备。脚本不修改 BCD、系统安全开关或证书信任，不主动重启。Windows 返回 3010 时打印需要用户安排重启并保留该退出码。

设备安装工具仅匹配 ROOT\DDTransVirtualAudio。首次安装失败会尝试移除刚创建的节点；移除流程只删除匹配的设备及其已关联的 OEM 驱动包，不操作其他品牌虚拟声卡。

正式分发应准备适用的 Microsoft 签名流程；本次仅提供开发包。当前主机 Secure Boot 与 HVCI 开启，测试签名未开启；当前用户的开发证书链以不受信任的根结束（PowerShell 状态 UnknownError），未导入根信任。故停止在加载前。

## 设置页

设置页增加“发言翻译”：保存默认发送语言，自动选择真实麦克风，自动绑定唯一的 DDTrans 播放/录音配对端点，开始时只发送译音。源语言自动处理，无源语言下拉框。已有听译会话运行时必须先停止，不静默替换；自己的监听继续使用独立设置。每次新建发言会话的原声为 0；会话内调整只改变 outgoingOriginalGain，暂停恢复保留，停止后还原收听 originalGain（包含原本为 0 的设置）。

缺少设备时明确显示尚未检测到，不把普通扬声器当作虚拟麦克风。默认发送语言独立于收听翻译的目标语言，设置不会立即打断当前会话。

## 验证记录

- x64 驱动与原生工具编译通过。
- 缓冲完成 50000 次随机读写和参考队列对照，覆盖顺序、溢出保留最新数据、欠载补静音、停止清空及重新开始不播放旧内容。
- InfVerif /w 通过；Inf2Cat signability 检查无错误、无警告。它们不是驱动正式签名或硬件兼容性认证。
- 原生工具查询确认当前没有 DDTrans 端点；WASAPI 收音探针对缺设备明确失败，不播放默认扬声器。
- 应用自动化测试 84/84 通过，覆盖发言与收听的会话隔离、设备唯一配对、缺设备拒绝启动、设备断开暂停、原声增益恢复、模式/sessionId 校验及设置保存。
- verify:desktop、verify:overlay、verify:audio-routing、verify:capture、verify:loopback 均通过；其中桌面/悬浮窗使用本地模型替身，未调用收费模型。音频路由专项包含真实 Web Audio 混音及 Windows 输出/回采、发送语言快速关闭保存与收听语言隔离、无驱动时按钮禁用和页面无水平溢出。
- 最终构建、签名、包哈希与当前未加载状态记录在 data/probes/virtual-microphone-development.json。

尚待在已安排好的驱动测试环境完成：安装/升级/卸载、重启后枚举、WASAPI 真实 Render→Capture 收音、会议/游戏共享客户端、暂停/恢复、异常退出静音、设备禁用/启用、Windows 端点音量/静音、睡眠唤醒和长会话。每一项都需要实际证据，不能由编译成功代替。

## 官方参考

- Microsoft SimpleAudioSample：https://github.com/microsoft/Windows-driver-samples/tree/d65f6bb4041fa74f969e78ce2cfc230a71e824b4/audio/simpleaudiosample
- Friendly names：https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/friendly-names-for-audio-endpoint-devices
- Driver signing：https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-
- TESTSIGNING：https://learn.microsoft.com/en-us/windows-hardware/drivers/install/the-testsigning-boot-configuration-option
