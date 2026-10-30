# Windows 安装包与虚拟麦克风

日期：2026-10-30。本文取代此前自研开发签名驱动的安装路线。

## 交付目标

用户从 GitHub 下载一个 `DDTrans-Setup-2.1.0-x64.exe`，安装应用时一并安装虚拟音频设备。安装包包含完整原厂驱动，安装时无需另行下载 VB-CABLE、进入 BIOS、关闭 Secure Boot 或启用测试签名。新装驱动后提示正常重启 Windows；安装器不自动重启。

当前发布目标为 Windows 11 x64。ARM64 和其他系统需要独立的打包与运行验证。

## 采用的方案

使用 VB-Audio 官方基础版 VB-CABLE Pack45，保留完整原始 ZIP、解压文件、原厂说明及数字签名。内核驱动没有重新编译或修改 INF。原厂目录文件的发布者是 Microsoft Windows Hardware Compatibility Publisher，构建时执行 `signtool verify /kp /c ...` 验证。

原厂下载：<https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip>

固定 SHA-256：`B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB`。

版本和文件校验以 `native/virtual-audio/vendor.json` 为准，准备脚本检查原始 ZIP、INF、CAT 和 SYS。原生安装工具再次检查三个驱动文件与目录信任后才注册设备。Windows 对实际安装执行自己的驱动签名验证。

## 安装、名称和复用

NSIS 安装器按每台电脑安装到受保护的 Program Files 目录，正常请求管理员授权。原生工具通过 Windows SetupAPI 创建原厂硬件 ID `VBAudioVACWDM` 对应的根设备，再安装未经修改的签名 INF。

本次新安装的主端点显示为：

- DDTrans Virtual Input (VB-Audio Virtual Cable)：DDTrans 写入音频的播放端。
- DDTrans Virtual Microphone (VB-Audio Virtual Cable)：会议、游戏选择的录音端。

显示名称通过管理员 `IMMDevice::OpenPropertyStore(STGM_READWRITE)` 修改，不改变原厂驱动名称、Provider 或数字签名。原厂 16 通道播放端保持原样；应用的发言翻译排除该端点。设备身份通过原厂硬件祖先和固定包的拓扑连接器识别，不依赖中文 Windows 的“扬声器”等本地化名称。

对 DDTrans 新建设备的播放端写入微软公开的 `PKEY_AudioDevice_NeverSetAsDefaultEndpoint`，避免虚拟线缆被系统自动选成默认扬声器；已有共享设备保持其原配置。名称配置只写入发生变化的属性，并在提交后重新读取验证，安装重试不会反复触发同一端点的属性变更。

已有 VB-CABLE 安装会直接复用，保留原名。设置页显示外部软件实际应选择的录音设备。找不到完整配对时，发言翻译拒绝启动；多个匹配时要求明确选择，跨 Provider 的名称不交叉配对。原有手动路由与明确选择扬声器的试播功能保留。

新装驱动返回 `3010`，安装器提示用户稍后重启。若系统尚未枚举端点，安装器注册一次登录时执行的设备命名任务；任务只运行受保护安装目录中的原生工具，完成后移除。卸载应用时清理该任务，保留可能被其他程序使用的 VB-CABLE 设备；原生 `remove-owned` 仅能删除拥有安装记录的 DDTrans 新建设备，不会删除预先存在的设备。

## 分发依据

官方许可页的 “VB-CABLE Distribution with other product” 明确允许在 Donationware 条件成立时，将基础 VB-CABLE 包嵌入免费或商业应用的安装程序。适用条件是用户能识别 VB-CABLE 来源，并能了解、参与其 Donationware 模式。因此安装器、应用设置页和随包说明均保留 VB-Audio 来源与捐赠信息。

随包旧版 readme 对集成安装要求作者许可，采用的公开许可依据是官方当前发布的上述分发条款。企业、机构等无法适用该模式的分发需要对应许可。VB-CABLE A+B、C+D 不在本安装包中。

官方条款：<https://vb-audio.com/Services/licensing.htm>（核对日期：2026-10-30）。

## 安装版的连接和数据

安装版不携带项目 `.env` 或任何真实 API Key，不依赖 Node.js、Python、WDK 或额外数据库服务。Electron 后台自动启动，SQLite 与录音写入当前用户的 `userData/data`。

通过音频设置中的“翻译服务配置”填写当前 Qwen 3.8 的实时 WSS 地址和自己的 Key。Key 使用 Electron `safeStorage` 的 Windows 本机保护加密保存；页面只得到是否已配置的状态。空 Key 保留已有值。同传启动中、进行中或暂停时，拒绝修改服务配置；保存不会重启后台或更换本地 HTTP 地址。

开发模式继续使用仓库 `.env`，原 Key 不变。多模型管理未扩展。

## 构建与验收

构建机需要 Node.js >=24.13.0、Visual Studio C++ x64 工具与 Windows SDK 用户态头文件；不再需要 WDK。用户安装不需要这些组件。

```powershell
npm ci
npm test
npm run dist:win
npm run verify:package
node scripts/verify-packaged-app.cjs
# 完成真实安装后，可额外验证应用自身的音频通路：
node scripts/verify-packaged-app.cjs 'C:/Program Files/DDTrans/DDTrans.exe' --require-virtual-audio
```

`dist:win` 在构建机下载固定版本的原厂驱动；生成的 EXE 是离线完整安装包。`verify:package` 检查真实 ASAR 与原厂 payload，不把开发目录、凭据或编译中间产物打入安装包。

安装后的只读检查与音频探针：

```powershell
& 'C:/Program Files/DDTrans/resources/virtual-audio/ddtrans-audio-device.exe' status
pwsh -NoProfile -File scripts/probe-virtual-audio.ps1 -PayloadDirectory 'C:/Program Files/DDTrans/resources/virtual-audio'
```

探针仅接受原生检查工具验证过的配对端点 ID，测试 997 Hz 写入/收音及停止后的静音。不通过普通扬声器代替虚拟设备测试。不会调用真实翻译模型。

本地证据放在 `data/probes/bundled-virtual-audio-preflight.json`、`bundled-virtual-audio-install.json`、`packaged-app.json` 和 `bundled-virtual-audio-runtime.json`。两个音频探针使用同一对真实端点，必须串行运行，防止彼此的测试音干扰停止后静音检查。

## 2026-10-30 本机实测

环境为 Windows 11 x64。原厂驱动已在本机实际安装并启动，主播放端和录音端均为活动状态；录音设备已显示为 `DDTrans Virtual Microphone (VB-Audio Virtual Cable)`。

- 原厂目录签名与内核策略校验通过；全部 31 个 vendor 文件与固定原厂 ZIP 一致。
- Secure Boot 开启，HVCI 正在运行，测试签名关闭，未修改 BIOS、启动配置或证书信任。
- 最终 EXE 在 `C:\Program Files\DDTrans` 完成升级安装，退出码为 **0**，本次不要求重启；此前首次安装曾返回 3010。安装器不会自动重启电脑。
- 别名配置已完成，一次性任务和 pending 标记均已清理。构建与安装目录的原生工具 SHA-256 一致。
- 系统默认播放端仍为 Realtek，默认输入仍为原实体麦克风。
- 安装目录中的 WASAPI 探针通过：48 kHz 双声道，997 Hz 幅度约 0.07984，停止后峰值为 0，检查了 24,480 个静音采样。
- 真实安装版 Electron/Chromium 通路通过：枚举到完整设备配对，应用内测试音由虚拟麦克风收到，幅度约 0.07988。没有使用普通扬声器代替验证。
- 安装版不读取开发凭据即可启动，数据库写入当前用户目录；真实 Windows 凭据加密、空 Key 保留、后台原地址保持和无活动会话检查通过。全程未调用收费翻译模型。
- `npm test`：100/100；完整安装包及 36 个 payload 文件校验通过。

最终本地安装包：`release/DDTrans-Setup-2.1.0-x64.exe`，123,858,026 字节。SHA-256：`EB09A0081CA33CB725F1D7BD8ADC056941030ABA7FFCCAF4655A844F659E97C6`。

本机已有上述运行证据。全新电脑首次安装、普通重启后的运行和具体会议/游戏中的真人翻译仍需在对应环境验收；不把本机升级安装结果当作这些场景的测试记录。

## 官方接口参考

- 音频端点管理员属性写入：<https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdevice-openpropertystore>
- 音频端点名称：<https://learn.microsoft.com/en-us/windows/win32/coreaudio/pkey-device-friendlyname>
- 原厂端点改名说明：<https://vb-audio.com/Cable/VBCABLE_ReferenceManual.pdf>
- 原厂许可与嵌入安装分发：<https://vb-audio.com/Services/licensing.htm>
