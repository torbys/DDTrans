# DDTrans 虚拟麦克风开发包

此包供 Windows 11 x64 驱动开发验证，尚未完成内核加载、外部收音或兼容性验收。开发签名不等同于 Microsoft 发布签名。

## 内容

- package/DDTransVirtualAudio.sys、DDTransVirtualAudio.inf、DDTransVirtualAudio.cat：配对播放/录音端点驱动。
- ddtrans-device-tool.exe：端点和代码完整性策略检查，以及专属硬件 ID 的安装/移除。
- ddtrans-probe.exe：WASAPI 997 Hz Render→Capture 收音及停止后静音检查；仅打开 DDTrans 端点。
- DDTrans-Development.cer：公开开发证书；包中没有私钥。
- install.ps1：默认只读检查，不修改启动配置、证书信任或安排重启。
- package-manifest.json：文件 SHA-256 与开发状态。

## 检查

在解压目录运行：

~~~powershell
pwsh -NoProfile -File ./install.ps1
~~~

如果测试签名未启用、Secure Boot 策略不允许开发签名驱动，或开发证书尚不受信任，先安排测试环境；简单重启不会添加设备。开发包不会自动关闭安全功能或导入根证书。

## 安装、验证与移除

仅在测试环境已就绪的管理员 PowerShell 中运行：

~~~powershell
pwsh -NoProfile -File ./install.ps1 -Action Install
./ddtrans-device-tool.exe status
./ddtrans-probe.exe
~~~

端点应为 DDTrans Virtual Input（播放）和 DDTrans Virtual Microphone（录音）；Windows 可附加适配器名称。探针通过后，应用设置页选择默认发送语言并开始发言翻译，在会议或录音软件选择 DDTrans Virtual Microphone。先验证仅译音，再验证原声混合；停止应用后应收到静音。

移除：

~~~powershell
pwsh -NoProfile -File ./install.ps1 -Action Remove
~~~

返回 3010 表示 Windows 要求重启，由用户安排；脚本不会自动重启。设备禁用/启用、多个共享客户端、升级、睡眠唤醒、异常退出与长会话仍需验证。
