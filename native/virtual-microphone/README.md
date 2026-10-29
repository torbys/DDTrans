# DDTrans Virtual Microphone

Windows 11 x64 的最小 PortCls/WaveRT 虚拟音频驱动。配对端点：DDTrans Virtual Input（播放）与 DDTrans Virtual Microphone（录音）。硬件格式为 48 kHz、单声道、signed PCM16；适配器内的有界缓冲将播放数据提供给录音端，停止/超时输出静音。

## 从源码构建

在仓库根目录运行：

~~~powershell
npm run driver:restore
npm run driver:build
npm run driver:check
npm run driver:sign-dev
npm run driver:package
~~~

需要现有的 Visual Studio 2022 C++ x64 工具及 Windows SDK 10.0.26100.0。恢复脚本仅下载并解压锁定版本 WDK，构建脚本运行缓冲测试、InfVerif 和 Inf2Cat。产物位于 data/driver-development；测试签名的私钥只存在当前用户证书存储，不可导出。默认检查命令不修改系统。

## 开发包与真实设备验证

[INSTALL.md](INSTALL.md) 说明独立开发包的检查、安装、移除和 WASAPI 探针。安装必须在安排好的驱动测试环境进行；工具不修改启动配置，也不主动重启。

当前源码完成离线构建和应用接入，尚未安装/加载或完成外部收音验证。完整记录与剩余验收见 [开发记录](../../docs/virtual-microphone-development-2026-10-29.md)。正式分发需要独立的签名与兼容性验收。

## 来源

驱动骨架来自 Microsoft SimpleAudioSample，固定版本、MIT 许可及本项目改动见 [UPSTREAM.md](driver/UPSTREAM.md) 与 [LICENSE](driver/LICENSE)。应用、音频桥和原生工具使用现有仓库的构建方式，不增加运行时服务。
