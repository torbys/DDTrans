# DDtrans · Qwen 3.8 实时同传

> 视频演示：https://www.bilibili.com/video/BV15DE86xExk?t=2.4

基于 Electron 的桌面同传工具。独立媒体宿主持有音频采集、翻译连接和译音播放，Node 网关处理 Qwen 3.8 协议，SQLite 保存会议、说话人段落、笔记和录音。

## 安装与启动

需要 Node.js >=24.13.0。执行 npm ci，按 .env.example 配置原有 DASHSCOPE_API_KEY 和 QWEN_WS_URL，然后执行 npm start。Electron 自动托管本地 Node 服务，等待就绪后打开主页面；停止和退出会等待尾段保存。start.bat 提供同一启动入口。

业务空间 HTTP compatible-mode/v1 地址应改用同域名的 wss /api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime 地址。凭据由 Node 服务读取；.env、数据库、录音和测试探针均不纳入 Git。

## 使用

1. 从主页新建会议，设置名称、目标语言与麦克风；源语言自动识别。
2. 在同传页选择麦克风、系统声音或混合采集。按需设置原文到译文的热词，开始前选择是否开启 AI 语音。
3. 原文、译文按稳定段落关联并显示会话内说话人编号。暂停释放采集，恢复沿用同一会话；笔记自动保存。
4. 停止后等待已保存，在历史管理页查看、搜索、改名、删除记录，在详情页按需播放原声与译音。

当前桌面版本默认仅生成文字；支持语音的目标语言可在开始前开启 AI 语音。进行中的会议禁止从管理接口改名或删除。系统声音播放启用时，应用要求本机支持排除自身播报的系统回采，避免重复翻译。

## 数据

会议和段落元数据存入 SQLite，PCM 持续写入 WAV。原文 source_item_id 关联译文与迟到音频，完成时等待 session.finished；中断会保留已收到的数据。旧库迁移前自动建立备份。speaker_id 是会话内编号，不代表跨会话身份。

## 验证

- npm test：22/22 通过，覆盖网关、SQLite、采集重采样和媒体会话。
- npm run verify:desktop：主页建会话、成对字幕、暂停恢复、尾段与笔记保存、历史列表通过，无控制台错误。
- npm run verify:capture：Windows 系统声 16 kHz / 每帧 320 样本、排除自身音频和停止释放通过。
- npm run verify:loopback：系统回采隔离与 TTS 实际输出音量专项。
- npm run verify:live -- 指定16k录音：真实模型验证，会上传指定测试音频。

协议字段与既有真实模型证据见 [Qwen 3.8 协议实测记录](docs/qwen3.8-protocol-verification-2026-10-28.md)；网关与存储接口见 [Node 网关记录](docs/node-gateway-2026-10-29.md)。当前模型传输为 WebSocket。
