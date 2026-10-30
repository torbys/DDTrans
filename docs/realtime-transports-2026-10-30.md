# Qwen 3.8 连接、协议实测与断线保存（2026-10-30）

结论：当前产品唯一主连接继续使用 WebSocket。WebRTC 和 AOQ 均已完成真实连接与音频输入输出探针，但不将实验路径放进产品连接选择器。

## 401 的真实原因与修复

开发环境读取项目 .env；安装版读取当前用户的加密 connection-settings.json，两者独立。本机检查发现开发配置的专属业务空间地址和 Key 可连接，安装版此前保存的是公共地址和另一把 Key，返回 HTTP 401；将安装版那把 Key 发送到专属地址也返回 401。因此本次不是模型名错误，也不是当前 .env 中的有效 Key 失效。

已在本机备份原加密配置，并同步到 .env 中经过真实握手验证的专属地址和 Key。复验模型为 qwen3.8-livetranslate-flash-realtime，配置确认耗时 261 ms。Key 未写入页面、探针 JSON 报告、文档或安装包，项目 .env 未被此次修改。

设置页新增“测试连接”。点击保存时也先完成真实 session.updated 校验，成功后才提交保存。支持直接粘贴业务空间的 HTTPS Base URL，转换成同域名的 realtime WSS 地址。401、403、404、429 分别说明凭据、权限、地址、额度或限流问题；鉴权错误不自动重试。

## 官方资料核对

2026-10-30 阅读以下官方页面：

- [实时语音/音视频翻译](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)，页面更新于 2026-10-28。
- [Realtime API 概述](https://help.aliyun.com/zh/model-studio/realtime-api-overview)，页面更新于 2026-10-27。
- [WebRTC 接入](https://help.aliyun.com/zh/model-studio/realtime-webrtc-access)。
- [AOQ 接入](https://help.aliyun.com/zh/model-studio/realtime-aoq-access)。
- [Token 鉴权](https://help.aliyun.com/zh/model-studio/realtime-token-authentication)。
- [SDK 下载](https://help.aliyun.com/zh/model-studio/realtime-sdk-download)，页面更新于 2026-10-28。

概述中的 AOQ 平台表只列移动端，下载页已经提供 Windows 和 Electron。实测使用官方 `aoq-electron-sdk@1.4.0-59463182`（原生版本 `1.4.0.2610270958`），SDK 已验证 npm 发布包 SHA-512。约 21.2 MB 压缩包、32 MB 解压体积，仅存本地探针目录，没有加入产品运行依赖。

## 实际请求

WebSocket：`wss://<业务空间域名>/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime`，Bearer Key 在后台请求头中携带。收到 session.created 后发送：

```json
{
  "type": "session.update",
  "session": {
    "output_modalities": [
      "text",
      "audio"
    ],
    "audio": {
      "input": {
        "format": {
          "type": "pcm",
          "sample_rate": 16000
        },
        "turn_detection": {
          "type": "speaker_detection",
          "threshold": 0.5,
          "silence_duration_ms": 1000
        }
      },
      "output": {
        "format": {
          "type": "pcm",
          "sample_rate": 24000
        },
        "voice": "Tina"
      }
    },
    "translation": {
      "language": "en"
    }
  }
}
```

服务端实际确认：模型 3.8、text/audio、目标英语、16 kHz PCM 输入、24 kHz PCM 输出、Tina、speaker_detection；并补充 create_response=true、interrupt_response=true。没有配置源语种，源语种由模型自动识别。发音人身份仅在当前供应商会话内成立，不能跨重新连接当作同一人。

本次固定样本未配置热词，以保持三条链路输入一致。产品热词通过 translation.corpus.phrases 设置；现有网关会核对服务端是否原样接受所请求的词表。

WebSocket 输入 input_audio_buffer.append（探针每帧 100 ms；产品采集帧 20 ms），结束发送 session.finish，等待 session.finished 后释放。探针把音频内容替换为字节数和 SHA-256 后记录事件。

WebRTC：后台代理 POST `https://<业务空间域名>/api/v1/webrtc/realtime?model=...`，Content-Type 为 application/sdp。真实 SDP 交换返回 200，ICE/DTLS 连接成功。监听客户端事件通道和服务端 txt 通道，session.updated 后才挂载 PCM 样本生成的媒体轨道。译音经远端 audio track 接收，通过 Web Audio 检测非静音；测试期间不向扬声器播出。

AOQ：相同 HTTPS 接口，Content-Type 为 application/json，请求体 {}，头 x-dashscope-rtc-transport: moq。实际获取连接凭证并由官方 N-API SDK 建连，凭证不输出。音频使用 Opus，上行外部 PCM；同样先禁止媒体发送，session.updated 后开启。提前发送静音也会触发“session already started”错误，这是本次实测确认的配置时序限制。

## 同音源测量

固定输入 `data/probes/fixtures/two-speakers-16k.pcm`，时长 25.355 秒，中文双说话人，目标英语，同时输出字幕和语音。Windows x64、Electron 45.1.0；无用户实时麦克风输入。以下为保留的代表性有效运行，不是多次统计的百分位或性能保证。

“配置就绪”从开始建连起算；首字幕和首译音从开始向模型发送样本起算，剔除建连时间。

| 协议 | 配置就绪 | 首原文 | 首译文 | 首译音 | 本次结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| WebSocket | 226 ms | 3223 ms | 3244 ms | 3475 ms | 两段原文、译文及全部响应完成事件，收到 1194240 字节 PCM |
| WebRTC | 1202 ms | 3213 ms | 3234 ms | 3550 ms | 两段字幕和非静音译音；音频 packetsLost=0，jitter=3 ms，候选链路 RTT=11 ms |
| AOQ Segment | 1581 ms | 3185 ms | 3202 ms | 3448 ms | 接收非静音 PCM 663840 字节，但本次样本内容和尾段关联未通过完整性验收 |

AOQ Segment 这次出现 3 个 response.output_item.done、2 个 response.done；不能把“收到 session.finished”直接等同于每段均已完整。另一轮 Stream 模式可得到完整文字，但没有非静音译音。SDK 还明确拒绝 Stream 下的 24 kHz 解码，要求换采样率或采用 Segment；改为 48 kHz Stream 后仍需继续验证译音下行。

AOQ 报告里的 networkStats.loss 原始值为 17，SDK 类型未说明单位，本报告不将其解释为丢包百分比。

WebSocket 做了两轮，首译文相对开始送音频约 3.15–3.24 秒。WebRTC 有效译音轮次与它接近。更换协议没有在这台机器、本段样本中带来明显的首字幕收益；模型处理时间占主要部分。WebSocket 更快配置就绪，已有完整 PCM 保存、尾段关联和重连路径，因此保留为当前主连接。

本轮没有人为给系统网卡注入丢包或限速。不能据此给出三种协议在不同弱网下的排名。对麦克风声学回声也未作跨设备 AEC 指标测试；回采与混音隔离另外通过实际音频路由验收，不与传输延迟混为一谈。

## 断线恢复与存储契约

- 供应商网络失败/5xx 在会话中最多重连两次，退避 500/1500 ms，每次连接最多 8 秒；第一次启动失败直接呈现原因。
- 用户可在重连中停止；取消计时器并终止正在建立的连接，不必等重试完成。
- 重连时本地音频继续写 WAV，不缓存并回放过时输入。缺失翻译的样本范围写入 metrics_json.gaps。
- 已收到的原文和译文立即 upsert 到 SQLite；未完成段标 interrupted。
- 新供应商连接的 item、response、事件 ID 加命名空间，时间戳平移到本地会话音轨；说话人重新编号。保留一个本地会议记录。
- 重连成功后继续当前目标语言、热词和音频配置，已中断的会议最终仍标 interrupted，明确存在缺口。
- 单次底层失败仅报告一次。已关闭的会话移出活动集合，停止后关闭本地 WebSocket，防止残留状态阻挡设置保存。
- 鉴权错误详情保留到停止后的页面，避免被“已保存”覆盖。

继续 SQLite；新增的断线次数、缺口、分连接指标使用当前会话的 JSON 元数据，无需 Redis 消息队列。云同步、多设备协作或共享服务端确立后，再考虑远端数据库。

## 复现

先配置本机 .env。Windows 可将固定版本 SDK 安装到忽略目录，不运行安装脚本。使用自己的 16 kHz、单声道、16-bit PCM 音频时，通过 --input 指定路径。下面的固定样本位于本机忽略目录，不随仓库分发。

```powershell
npm install --prefix data/probes/transport-sdk --ignore-scripts --no-audit --no-fund aoq-electron-sdk@1.4.0-59463182
.\node_modules\.bin\electron.cmd scripts\probe-transports.cjs --aoq-sdk data/probes/transport-sdk/node_modules/aoq-electron-sdk --out data/probes/transports/result.json
# 仅检查 AOQ 流式下行
.\node_modules\.bin\electron.cmd scripts\probe-transports.cjs --transports aoq --aoq-mode stream --aoq-sdk data/probes/transport-sdk/node_modules/aoq-electron-sdk --out data/probes/transports/aoq-stream.json
npm test
npm run verify:desktop
npm run verify:overlay
npm run verify:audio-routing
npm run dist:win
npm run verify:package
npm run verify:packaged-app
```

探针生成的 JSON 报告不记录 API Key、SDP 或 AOQ token。原始结果位于本机 `data/probes/upgrade-20261030`：transport-results-2.json、aoq-segment-result.json、aoq-result-3.json、websocket-events.json。API Key 和模型凭据不进入仓库。SDK 原生日志留在忽略目录，分享前应单独检查。
