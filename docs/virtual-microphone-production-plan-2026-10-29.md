# DDTrans Virtual Microphone 生产方案

日期：2026-10-29
范围：让 Windows 会议、游戏和录音软件在麦克风列表中看到 `DDTrans Virtual Microphone`，并能收到 DDTrans 已混合的原声与译音。本文覆盖路线、架构、验收和发布边界。

## 结论

当前 DDTrans 已具备这项工作的应用侧前提：48 kHz 单声道混音、原声/译音独立增益、独立监听、已有 Render Endpoint 的 `setSinkId` 路由，以及严格 JSON 设置合同。它还没有原生桥接、Windows 驱动、安装器或虚拟设备；本机探针也没有发现虚拟设备。因此，当前实现不能让会议或游戏选择 `DDTrans Virtual Microphone`。

推荐路线是先验证端到端音频合同，再决定是否自有驱动：

1. 使用用户自行安装的第三方虚拟线缆，把 DDTrans 混音发送到其 Render Endpoint，并在会议/游戏中选择配对的 Capture Endpoint。
2. 验证通过后，在“自有 Windows 驱动”与“取得可分发的第三方商业/授权方案”之间做产品决策。
3. 若做自有设备，第一版提供配对的 Render/Capture Endpoint：优先复用当前 `setSinkId` 经 Chromium/WASAPI 写入 Render Endpoint，驱动把这一条流提供给 Capture Endpoint；会议软件只看见后者。只有实测表明时钟、重连或可观测性不足时，才增加原生 WASAPI writer。不要一开始为应用设计私有 IOCTL 音频桥。

这不是翻译协议或模型问题。它消费的是应用已产生的固定 PCM 混音流，翻译 WebSocket、模型和服务端可以保持解耦。

## 新设备选项与设备名称

| 路线 | 会议麦克风列表中的结果 | 适合的阶段 |
| --- | --- | --- |
| 使用已有 VB-CABLE 等产品 | 出现该产品的 Capture Endpoint，名称通常保留厂商品牌 | 最快证明外部收音与翻译发送链路 |
| 自有最小驱动 | 安装后出现 DDTrans Virtual Microphone，并由应用送入混音 | 需要稳定自有名称与完整安装体验的版本 |
| 获授权的第三方集成 | 能否定制名称、捆绑及静默安装取决于实际授权 | 自研驱动之外的产品化选项，当前未确定供应方案 |

第一阶段的第三方验证不会自动满足“名称必须是 DDTrans Virtual Microphone”的最终要求。正式设备安装后可持续存在；DDTrans 停止时提供静音，启动后恢复声音，避免会议软件因设备消失自行切换麦克风。

## 产品边界与主线关系

如果用户只看同传字幕，虚拟麦克风是可选扩展；若产品承诺“把译音作为会议或游戏麦克风发送给对方”，它就是闭环中的必需能力。没有它，译音只能本地播放，不能成为其他程序可选的输入设备。

双向会话不能把所有声音混入同一条目标语言流。至少分成两条明确的通路：

```text
本地说话人 -> 识别/翻译/TTS -> 发送混音 -> Virtual Microphone -> 对方
对方说话人 -> 接收/识别/翻译/TTS -> 本地监听 -> 本机扬声器/耳机
```

发送混音只能包含本地麦克风及其对应译音，不能采集会议应用收到的远端声音再送回虚拟麦克风，否则会回声、串话或把对方原话回传。一个“同一目标语言、同一会话”的流不能同时表达两个方向各自独立的翻译；双向产品需要按方向分开的采集来源、翻译会话和输出总线。

## 首版应用流程：单向发言翻译

按当前需求，建议把它定义为“发言翻译”里程碑，接入现有同传主线：

1. 在设置页进入发言翻译，选择真实麦克风和要让对方听到的目标语言；源语言保持自动识别。
2. 默认发送“仅译音”，原声增益为 0；需要双语原声时再增加原声。自己的监听单独开关、单独选耳机。
3. 应用把该方向的混音送往 DDTrans Virtual Input，会议/游戏选择 DDTrans Virtual Microphone。
4. 停止翻译时系统设备继续存在并输出静音；恢复翻译继续送入同一设备。

现有“系统声音收听翻译”保留为另一种工作方式。首版不同时启动双向翻译；需要双向时再增加独立收听会话，并验证源、目标语言和回送隔离。网关、数据库和字幕归段继续复用现有实现，驱动只承担音频传输。

## 当前基线

已具备：

- 48 kHz、单声道的原声与 TTS 真实混音；原声/译音增益、TTS 开关、监听内容和监听音量彼此独立。
- 对已存在 Render Endpoint 的显式路由，缺失设备会报错而非回退到默认扬声器。
- 严格 JSON 路由设置、即时应用和原子保存。
- Windows 真实播放路径已验证；当前设备是普通扬声器，未验证外部程序通过配对 Capture Endpoint 收音。

尚不存在：`DDTrans Virtual Microphone` Capture Endpoint、与其配对的 Render Endpoint、`.sys`/`.inf`/`.cat` 驱动包、签名、安装/卸载和 PnP 生命周期处理。

`AudioContext.setSinkId()` 只能选择系统已经枚举出的输出端点。它适合第一阶段把现有混音送进第三方线缆的 Render Endpoint，但不能创建新设备。音频 APO 也不是替代方案：Microsoft 将 APO 定义为插入既有音频处理图的用户态 DSP，且 APO 不能改变底层逻辑设备的 KS 拓扑。因此，改设备显示名或添加 APO 都不能凭空新增一个麦克风端点。[来源 7](#来源与访问日期)

## 最小可交付架构

### 第一阶段：第三方端点的端到端证明

```text
DDTrans 48 kHz mono mix bus
    -> 现有独立输出 / user-mode writer
    -> 第三方 Virtual Cable Render Endpoint
    -> 该产品的配对 Capture Endpoint
    -> Teams / Discord / 游戏语音 / 录音程序
```

此阶段的产物是可复现的设备选择与录音回放记录，不是将第三方驱动捆绑进 DDTrans。优先复用现有 `setSinkId` 输出；如浏览器输出行为无法提供所需格式、重连或指标，再加入一个小型原生 user-mode WASAPI writer。它只把混音写入标准 Render Endpoint，不操作驱动私有接口。

验收：

- 在设置中选择第三方 Render Endpoint 后，会议/游戏麦克风列表能选择其配对 Capture Endpoint。
- 原声与译音均能录到外部程序；任一路增益为零时，对应频率/语音不再被录到；本地监听开关不改变发送总线。
- 设备缺失、被禁用或重新枚举时，DDTrans 明确报错并停止该路由，不静默改投默认扬声器。
- 停止/重开翻译会话后，外部程序持续看到同一 Capture Endpoint；无输入时收到静音而不是陈旧 PCM。

VB-Audio 当前许可页分别规定不同产品与分发场景：基础 VB-CABLE 在终端用户能识别其 VB-Audio 身份、仍适用 donationware 模式等条件下，可以随应用分发；特定专业部署需要购买相应数量许可；VB-CABLE A+B、C+D 明确不能与其他产品捆绑分发。这些条件不能推导为可以任意去除厂商品牌或改造成 DDTrans 自有设备，定制名称及商业集成仍需核对实际适用授权。[来源 12](#来源与访问日期)

### 第二阶段：自有驱动的最小数据路径

```text
DDTrans mix bus (48 kHz mono)
    -> selected Render output:
         current setSinkId (Chromium/WASAPI, first choice)
         native WASAPI writer (only if measured clock/reconnect/telemetry need)
    -> DDTrans Virtual Input [Render Endpoint]
    -> Windows audio engine / KS / WaveRT miniport
    -> driver-owned bounded bridge buffer
    -> DDTrans Virtual Microphone [Capture Endpoint]
    -> Windows audio engine / WASAPI capture
    -> 会议、游戏、录音软件
```

面向用户显示的关键设备名是 Capture Endpoint：`DDTrans Virtual Microphone`。Render Endpoint 可命名为 `DDTrans Virtual Input`，供 DDTrans 自己选择，不要求用户在会议软件中操作。

WASAPI/MMDeviceAPI 的职责正好覆盖此接口：应用枚举端点并对端点 render/capture 流；WaveRT 由音频引擎与 miniport 通过循环缓冲建立 render 或 capture 流。WaveRT 可减少复制，但这不代表可以省略驱动的实时状态、格式、缓冲与 PnP 实现。[来源 4](#来源与访问日期) [来源 5](#来源与访问日期)

首版固定 PCM 合同为 `48 kHz / mono`，格式选择应在开发时根据驱动公开的格式能力定为一种明确的 PCM 表示。首选由当前 `setSinkId` 选择该 Render Endpoint；只有实测证明 Chromium 输出无法满足时钟稳定性、设备重连或所需诊断指标时，才增加原生 WASAPI writer。缓冲必须有上限，并计数写端饥饿、捕获端欠载、静音填充、格式拒绝和重连次数；不在方案阶段承诺具体延迟、性能或缓冲数值。

不要在第一版做“Electron IPC 每帧 -> 私有 IOCTL -> Capture”路径。它引入应用、权限和内核接口的额外实时契约，却没有给会议软件带来任何必要能力。正常 Render/Capture Endpoint 对已经是 Windows 音频客户端的稳定边界；私有控制接口最多留给以后诊断或配置，不承载实时 PCM。

### SysVAD 的正确用途

Microsoft 的 SysVAD 是 WDM 虚拟音频设备驱动示例，展示多个音频设备、WaveRT 和端点实现，适合拿来建立项目骨架和理解 INF/拓扑。[来源 1](#来源与访问日期)

它不是现成的“虚拟线缆”。当前样例说明明确写出其不实现音频混音，capture/loopback 以生成正弦音模拟，并因此存在预期失败的音频 HLK 测试。自有实现必须明确补上“Render 流到 Capture 流”的真实、有界、静音优先桥接，以及格式、时钟、并发打开和电源状态处理；不能把 SysVAD 编译安装后当作完成。[来源 2](#来源与访问日期)

## 分阶段产物、验收与边界

| 阶段 | 产物 | 验收 | 本阶段不做 |
| --- | --- | --- | --- |
| A. 路由证明 | 第三方线缆的设备绑定说明、外部录音证据、失败状态记录 | 配对 Capture Endpoint 在至少一个会议/游戏和一个录音工具中可用；混音控制真实生效 | 自有驱动、捆绑第三方安装包、签名流程 |
| B. 产品决策 | 自有驱动与第三方授权的可审查决策；支持的 Windows/架构矩阵 | 业务、发布、授权和维护责任明确 | 用未经确认的第三方许可发布 |
| C. 驱动原型 | Windows 11 x64 驱动项目、Render/Capture pair、固定 PCM 合同、诊断计数 | 测试机中两端点出现；外部应用从 Capture 收到本应用 Render 的 PCM | 私有 IOCTL 实时通道、复杂混音器、双向自动路由 |
| D. 应用接入 | `setSinkId` 端点绑定、设备枚举/重连状态、既有 JSON 设置扩展；原生 writer 的实测决策记录 | 设备重启、禁用/启用、拔插等价 PnP 变化后状态可理解且可恢复；原生 writer 仅在已有输出未满足时新增 | 把原生 writer 预设为必需进程、改动翻译协议、模型或服务端 |
| E. 安装与发布 | Windows 11 x64 驱动包、安装/卸载流程、签名提交记录、兼容性测试记录 | 干净安装、升级、卸载、重启、休眠恢复均可复现 | 未签名或测试签名向客户正式分发 |

阶段 A 是继续自有驱动前的门槛：如果 DDTrans 的混音、设备选择或回声边界在第三方 Render/Capture pair 上都不能稳定通过，先修应用路由，而不是把问题带入内核。

## 驱动、架构与构建边界

### 端点与防回送策略

- Capture Endpoint 是会议/游戏只读的麦克风来源；DDTrans 不从它采集作为翻译输入。
- Render Endpoint 只接收 DDTrans 的“发送混音”。它不能是系统默认扬声器，也不能接远端会议声音的 loopback。
- 每个混音帧在应用内具有来源和目的地：`local-input -> send-bus`、`translated-local -> send-bus`、`remote-translation -> monitor-bus`。禁止 `remote-output -> send-bus`。
- 驱动在没有有效 Render 流、应用退出、桥接超时或恢复期间向 Capture 提供静音；不要保留旧缓冲反复播放，也不要让设备消失迫使会议应用自动换麦克风。

### Windows 11 x64 与后续 ARM64

第一期发布范围是 Windows 11 x64；ARM64 不属于第一期构建、测试或签名义务。出现明确的 ARM64 用户需求后，再单独增加 ARM64 驱动与应用侧原生组件的构建、签名和设备测试，不能用 x64 二进制代替 ARM64。

截至 2026-10-29，Microsoft WDK 下载页列出 WDK `28000.2526` 与 Visual Studio 2026，Visual Studio 2022 使用 WDK `26100.6584`；最终选择的 WDK/Visual Studio 版本要在仓库构建文档中锁定，不能只依赖开发机环境。[来源 10](#来源与访问日期)

驱动使用 WDM/PortCls/WaveRT 的最小职责实现。应用侧若需要原生 writer，应把它限制为设备枚举、WASAPI 初始化、格式协商、连续写入和状态上报；界面继续只经现有媒体宿主与严格 JSON 设置交互。不要把翻译会话、数据库或窗口逻辑放入该原生组件。

## 签名与发布：必须区分的三件事

不把“必须 HLK 才能安装”写成事实。Microsoft 当前文档区分以下路径：

1. **开发/实验室测试签名**：x64 内核驱动默认需要可验证签名才能加载；测试签名仅用于开发和测试，测试机需满足测试签名条件，不能向客户作为生产发布。[来源 8](#来源与访问日期) [来源 9](#来源与访问日期)
2. **Microsoft attestation 签名**：当前文档将它列为测试场景，可用于 Windows 10 Desktop 及更高版本的内核/用户态驱动，且不要求 HLK 测试；它不等于 Windows Certified，也不能向零售受众通过 Windows Update 发布。它不是“无需测试”的理由，仍须完成本方案的功能、可靠性和兼容性验证。[来源 3](#来源与访问日期)
3. **WHCP/WHQL 路径**：若目标包含零售 Windows Update 发布或 Windows 认证，应走 Windows Hardware Compatibility Program，并按目标 Windows 版本提交所需 HLK/HCK 测试日志。Microsoft 也说明，向 Windows Update 零售受众发布需要 WHCP submission。[来源 3](#来源与访问日期) [来源 6](#来源与访问日期)

需要有证据的账户与证书前置条件也应单独列入发布决策：向 Hardware Dev Center 提交 attestation 或 HLK 认证需要带 EV 代码签名证书的硬件开发者仪表板账户；注册资料还要求组织的 Microsoft Entra ID 全局管理员和可代表组织签署协议的法务联系人。EV 证书用于注册/提交的条件，不应在未核实具体流程前推断为 DDTrans 必须自行嵌入签署每一个最终二进制的唯一方式。[来源 11](#来源与访问日期)

不在本文记录任何证书、账户、测试实验室、第三方许可或商店服务的报价；这些取决于供应商和发布范围，必须在决策阶段取得正式报价或条款。

## 安装、退出与生命周期验收

安装器和卸载器是驱动产品的一部分，不能等端点“能响”后再补。正式交付前至少完成以下验证：

- **安装与升级**：管理员授权后的 Windows 11 x64 全新安装、覆盖升级、重启后枚举；验证设备名称、Render/Capture 数据流方向正确。ARM64 在其单独立项后按同一项验证。
- **卸载**：先停止输出并使 Capture 静音，再移除设备实例和驱动包；确认 DDTrans 不会留下后台写入者、失效设备选择或第三方组件。第三方设备由用户安装时，DDTrans 卸载不得删除它。
- **应用退出**：会议/游戏保持选中的 `DDTrans Virtual Microphone`，录音变为静音而非陈旧音频、噪声或设备消失；重新启动 DDTrans 后恢复送音。
- **长会话**：持续会议场景中记录 Render 写入、Capture 欠载、静音填充、重连与内存占用趋势；人工确认没有累积延迟、陈旧音频或回送。
- **重连与 PnP**：禁用/启用设备、驱动重启、默认设备改变及端点重新枚举后，应用显示可操作状态，并只在用户明确选择或唯一稳定匹配时恢复绑定。
- **休眠/恢复**：睡眠、休眠与唤醒后验证 WaveRT 状态、WASAPI 会话和设备通知；无效句柄必须释放并重建，不能继续写入旧缓冲。
- **并发与格式**：多个会议/录音客户端、48 kHz mono 之外的客户端请求、共享模式竞争和应用崩溃恢复都必须得到可诊断结果，而不是静默失声。

## 决策门

在开始生产驱动前，必须同时满足：

- 阶段 A 的外部 Capture 录音证明已完成，且发送/监听/回送边界清晰。
- 产品是否需要在会议软件中稳定保留设备名、是否需 Windows Update 分发，已形成 Windows 11 x64 的发布范围；ARM64 仅在明确提出后另行立项。
- 第三方路线已取得适用许可，或自有驱动的签名账户、组织主体和发布责任已落实。
- 自有驱动的固定 PCM 合同、静音失效策略、端点命名、安装卸载和测试矩阵已经评审。

在此之前，最小且正确的投入是第三方 Render/Capture pair 上的端到端验证；不应新建私有实时 IOCTL 协议，不应改翻译协议/模型，也不应把 SysVAD 当成可直接发布的虚拟线缆。

## 来源与访问日期

以下均于 2026-10-29 访问；Microsoft Learn 与 Microsoft 官方样例为一手资料。第三方仅引用 VB-Audio 官方许可页。

1. Microsoft, *SysVAD Virtual Audio Device Driver Sample*：https://github.com/microsoft/Windows-driver-samples/blob/main/audio/sysvad/README.md （访问：2026-10-29）
2. Microsoft, *SysVAD README — HLK testing limitations*：https://github.com/microsoft/Windows-driver-samples/blob/main/audio/sysvad/README.md （访问：2026-10-29，见 `HLK testing` 节）
3. Microsoft Learn, *Driver Signing Options*：https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings （访问：2026-10-29）
4. Microsoft Learn, *About the Windows Core Audio APIs*：https://learn.microsoft.com/en-us/windows/win32/coreaudio/about-the-windows-core-audio-apis （访问：2026-10-29）
5. Microsoft Learn, *Understanding the WaveRT Port Driver*：https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/understanding-the-wavert-port-driver （访问：2026-10-29）
6. Microsoft Learn, *Driver Signing Policy*：https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later- （访问：2026-10-29）
7. Microsoft Learn, *Implementing Audio Processing Objects*：https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/implementing-audio-processing-objects （访问：2026-10-29）
8. Microsoft Learn, *Introduction to Test-Signing*：https://learn.microsoft.com/en-us/windows-hardware/drivers/install/introduction-to-test-signing （访问：2026-10-29）
9. Microsoft Learn, *Test Signing*：https://learn.microsoft.com/en-us/windows-hardware/drivers/install/test-signing （访问：2026-10-29）
10. Microsoft Learn, *Download the Windows Driver Kit (WDK)*：https://learn.microsoft.com/en-us/windows-hardware/drivers/download-the-wdk （访问：2026-10-29）
11. Microsoft Learn, *Register for the Microsoft Windows Hardware Developer Program*：https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/register-for-the-hardware-program （访问：2026-10-29）
12. VB-Audio, *Licensing*：https://vb-audio.com/Services/licensing.htm （访问：2026-10-29）
