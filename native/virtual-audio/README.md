# DDTrans 随包虚拟音频设备

Windows x64 安装器集成 VB-Audio 原厂签名的基础版 VB-CABLE。产品使用方法、授权条件和验收命令见 [安装方案](../../docs/windows-installer-virtual-audio-2026-10-30.md)。

- `vendor.json`：固定上游版本与哈希。
- `device.cpp`：原厂包校验、SetupAPI 安装、硬件身份识别、端点显示名称、安装归属和一次性任务清理。
- `probe.cpp`：对指定端点进行 WASAPI 写入/收音和停止后静音检查。
- `THIRD-PARTY-NOTICES.txt`：安装器及应用随包的来源、Donationware 和许可说明。

```powershell
npm run audio:prepare
npm run audio:check
npm run dist:win
npm run verify:package
```

准备脚本只下载并编译安装辅助工具，不安装设备。设备安装由正常管理员授权后的 DDTrans 安装器完成。源码不包含任何第三方私钥或重新签名的驱动。
