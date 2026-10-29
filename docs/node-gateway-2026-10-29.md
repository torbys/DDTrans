# Qwen 3.8 Node 网关与会话存储

日期：2026-10-29

本里程碑提供可独立运行的本地 HTTP/WebSocket 服务、Qwen 3.8 实时协议适配和 SQLite 会话存储。服务只监听 127.0.0.1，模型凭据保留在 Node 进程中。

## 运行

需要 Node.js >=24.13.0。执行 npm ci，按 .env.example 配置原有 API Key 和完整 QWEN_WS_URL，再执行 npm run serve。SERVER_PORT=0 时服务自动分配端口；桌面入口接入由后续桌面里程碑完成。

模型连接使用 /api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime。session.updated 必须确认目标模型、输出模态、16 kHz 输入、24 kHz 译音、目标语言、说话人分段和热词；被忽略的配置会让建连失败。结束等待 session.finished，随后保存尾段与媒体。

## 数据与接口

会议、段落、笔记和音频元数据保存在 SQLite，PCM 通过有界写入器保存为 WAV。归段使用 source_item_id，关联原文、译文、说话人和迟到音频；中断保留已有内容并标记 interrupted。旧库迁移前建立备份，拒绝打开未知更新版本的 schema。

服务提供会议列表、详情、改名、删除、笔记、Range 音频播放和 /ws/translate。同源校验保护写接口与 WebSocket；进行中会议不能被管理接口改名或删除。数据库、录音、日志与本地探针位于被 Git 忽略的数据目录。

## 验证

npm test 使用临时数据库和本地 WebSocket 替身，覆盖网关配置回显、错误、乱序归段、尾段收尾、CRUD、迁移、媒体清理和会话隔离。npm run probe -- ... 可对用户指定的测试录音执行真实协议探测，真实探测会使用已配置模型。
