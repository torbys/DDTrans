# DDtrans 架构与模型升级评估

> 本文是实施前的评估快照，下面的“当前代码”和运行方式均指改造前状态。模型适配、AudioWorklet、增量落盘和 Electron 托管 Node 后台现已实现；本轮决定移除 Python 运行依赖。最终实现及真实测试结果见 [Qwen 3.8 协议实测记录](qwen3.8-protocol-verification-2026-10-28.md) 与 [README](../README.md)。

评估日期：2026-10-28。范围：当前工作区（包含已有未提交改动）、现有 SQLite 的只读统计、阿里云及 Electron 等官方文档。本轮只新增本评估文件，不修改业务代码、配置或数据库；没有发起付费模型请求或进行真实音频性能测试。

## 结论

需要对实时会话、音频管线和持久化做实质重构，但没有证据支持推倒 Electron + Python + SQLite 重写。先完成 qwen3.8 适配与保存闭环，再建设多窗口、文件任务和路由能力。当前主要风险来自状态与数据生命周期，而不是 WebSocket 本身。

建议继续使用 WebSocket 完成第一阶段。WebRTC 可以作为后续客户端直连方案；AOQ 需先验证 Windows/Electron 的 SDK 与集成路径。不能把换传输协议当作数据库、路由和多窗口改造的替代方案。

## 1. 当前真实架构

~~~mermaid
flowchart LR
  Input[麦克风 / 系统声] --> Renderer[Electron renderer<br/>混音 / 重采样 / UI / PCM缓存]
  Renderer -->|本地 WS: 二进制PCM + JSON控制| Python[FastAPI + asyncio]
  Python -->|云端 WSS: JSON事件 + Base64音频| Qwen[Qwen 3.5 Realtime]
  Qwen -->|识别 / 翻译 / 音频事件| Python
  Python -->|自定义JSON事件| Renderer
  Python --> Collector[全局内存收集器]
  Collector -->|收到stop后写入| DB[(SQLite)]
  Python -->|HTTP: 列表 / 详情 / 音频| History[管理 / 详情窗口]
~~~

- 实际 .env 的 QWEN_WS_URL 指定 qwen3.5-livetranslate-flash-realtime；SERVER_PORT 为 1145。没有在报告中复制 API Key。
- 云端地址是 wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...，使用 Authorization Bearer。它属于百炼 Realtime 事件协议，不是 Chat Completions，也不是 WebRTC 连接。
- renderer 到 Python：ws://localhost:1145/ws/translate；输入为二进制 PCM，start/pause/resume/stop 为 JSON。Python 将 PCM 转成 Base64，再通过 input_audio_buffer.append 发往云端。
- 音频采集使用浏览器 MediaStream、Web Audio、ScriptProcessorNode，逐块线性重采样到 16 kHz、16-bit、mono。云端译音按 24 kHz PCM 处理。
- 当前 TTS 接收路径把音频缓存成段，播放主要由暂停后的按钮触发，尚不是一个持续调度的实时音频输出引擎。
- 前端为原生 HTML/CSS/ES modules；Electron 锁定安装版本为 31.7.7。Python 依赖为 FastAPI、Uvicorn、websockets、python-dotenv，没有本地模型推理依赖。

代码入口：server/src/config.py:12；server/src/translator.py:53、73、116、280；app/js/translation.js:125、135、190、541；app/js/app.js:357、407；package-lock.json 中 node_modules/electron。

## 2. qwen3.5 → qwen3.8：必须适配的内容

用户提供的文档 URL 仍保留 qwen3-5 名称，但正文已同时描述 3.5 与 3.8，并将 3.8 列为推荐模型。不能仅凭 URL 名称判断文档版本。[S1]

| 项目 | 当前代码 | 3.8 的适配方向 |
| --- | --- | --- |
| 模型与地址 | 3.5；旧 DashScope 域名 | 改为 3.8；按官方当前 WorkspaceId、地域域名配置并验证账户权限 |
| 输出模态 | session.modalities | session.output_modalities |
| 原文增量 | conversation.item.input_audio_transcription.text；text/stash | conversation.item.input_audio_transcription.delta；累加 delta |
| 译文增量 | response.text.text / response.audio_transcript.text | response.text.delta / response.audio_transcript.delta |
| 源语言与 ASR | 显式指定 qwen3-asr-flash-realtime 和 language | 3.8 自动识别源语种，原文识别始终开启；界面需反映实际能力 |
| 音频配置 | 旧的 input_audio_format/output_audio_format/sample_rate | 按 3.8 的 session.audio 结构或已确认的默认配置处理；默认 16 kHz 输入、24 kHz 输出 |
| 默认断句 | 暂停时补静音促使完成 | 3.8 默认 speaker_detection；暂停、收尾和重新开始分别定义语义 |
| 消息归属 | 用一个 current_item_id 追踪原文、译文、音频 | 通过 item_id、previous_item_id、response_id 等真实关系归并，接收 speaker_id 和时间信息 |
| 结束 | stop 时保存；断连 finally 才 session.finish | 停采 → session.finish → 等 session.finished → 完整落库 → 返回 stopped → 关闭 |

官方当前北京 WebSocket 示例地址：[S1]

~~~text
wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime
~~~

新加坡使用对应地域域名。API Key、业务空间与地域要匹配。旧域名在当前账号是否仍受支持，本轮没有通过真实请求验证，不能直接断言已停用。

3.8 的源语言自动识别不等于原有“指定源语言”的配置被原样保留。多模型设置应区分“用户期望源语言”“实际识别语言”“该模型是否允许固定源语言”。[S1]

接收逻辑还要处理新增事件、错误形状与会话配置确认。当前 configure_session 固定读取两条消息，未以收到 session.updated 为完成条件；建议使用单一接收循环，将配置确认、流式结果与错误分别分发，而不是猜测消息数量。

原文与译文也不是天然同一个 item_id。官方服务端事件通过 conversation.item.created 的 previous_item_id 关联原文消息；当前将该事件简化成 item_created，丢失了关联所需信息。[S2]

不建议长期保留 3.5 的两套解析路径。完成 3.8 验证后删除旧解析；未来第二个实际供应商接入时，再增加对应的协议转换模块。

## 3. 当前需要优先修复的问题

### 3.1 保存时序与会话隔离

server/src/main.py:25 全局创建一个 SessionCollector，各连接的 start 会清空同一个收集器。第二个窗口或视频任务进入后，会发生会话数据互相覆盖。

main.py:258 在收到 stop 后立即 flush_to_db；session.finish 位于 finally（约 291 行），完成顺序倒置。app/js/app.js:280 发 stop 后固定等 500 ms，再关闭采集和连接，未等待 stopped 确认；app/js/translation.js:453 的 cleanup 直接 close WebSocket。直接断连路径也没有持久化当前会话。

应在开始时创建独立会话记录；段落完成后增量持久化；停止时先接完尾部，再完成最后一笔事务。异常退出的会话保留为 interrupted，恢复应用后可以识别与继续处理。

### 3.2 段落归并会冻结不完整内容

translator.py:220 的首次 flush 会将 item_id 加入 _flushed_item_ids；原文 completed、译文 done、音频 done 都可能触发它。先到的完成事件把内容冻结，后到的文本或音频不再更新；同时单个 _current_item_id 还会在不同消息间反复重置缓存。

应按消息关联维护段落记录，让原文、译文、音频分别更新；具备明确完成条件后再最终化。数据库使用稳定的段落标识与唯一约束，避免把重连、重发、重复停止变成重复记录。

现有数据库的只读统计：3 个会话、60 个段落。按 trim(coalesce(text,'')) 判断，7 段原文为空，23 段译文为空或只有空白；原始音频和 TTS 音频字段均为空；3 个会话时长均为 0。这说明已有记录存在完整性问题；未回放对应历史音频，不能将每一条缺失都归因于同一个原因。

会话时长为 0 的代码原因很明确：SessionCollector.started_at 没有传给 create_session，记录是在停止时才创建，随后立即 end_session。见 database.py:305、336。

### 3.3 音频与缓存

- 前后端都将多个 Base64 音频块拼成字符串再统一解码（translator.py:230；translation.js:550）。对独立编码且带 padding 的块不可靠。最小验证中，AQI= 与 AwQ= 拼接后统一解码只得到 0102，逐块解码再拼接得到 01020304。应按实际事件编码约定逐块解码，再合并 PCM 字节。
- rawAudioChunks、audioBlobs 和 asyncio.Queue 都没有容量限制；浏览器发送也不检查 bufferedAmount。网络变慢或长会议会积累内存与延迟。
- 仅 16 kHz、16-bit、mono 原始 PCM 就约 110 MiB/小时，还没有计入译音、Base64、数组对象和合并复制。应将完整录音流式写文件，仅在内存中保留短播放缓冲。
- resample 每块独立 floor 输出长度且无抗混叠滤波；48 kHz、4096-frame 输入时，舍弃分数采样累计约造成 0.879 秒/小时的时基误差。对本地视频字幕尤其不合适。
- ScriptProcessorNode 已被 AudioWorklet 替代。应迁移到音频处理线程，使用连续相位的重采样与明确时间戳，并让 DOM 更新脱离音频回调。[S7]
- 现有 4096-frame 块在 48 kHz 下约 85.3 ms；如果实际输入为 16 kHz，则为 256 ms。BUFFER_SIZE 不能直接当成固定 256 ms。后续按实际采样率和测量结果确定较小发送块。
- 暂停补静音每 100 ms 发送 8192 字节；按 16 kHz PCM 计算却代表 256 ms 音频，发送速率与媒体时间不一致（main.py:126）。需要重新定义暂停收尾。
- 混音上下文和原始麦克风流未完整记录、回收；播放 stop 会触发 onended 自动播放下一段，存在取消竞争。统一记录资源归属，停止时用会话代次或取消标志阻断旧回调。

当前 ScriptProcessor 回调只读 inputBuffer，输出为静音；连接 destination 用于让节点持续处理。音频隔离需要解决的是输出设备的译音被系统音频回采路径捕获。

### 3.4 音源与存储 API

系统声捕获失败时会静默退回麦克风（audio-capture.js:57）；混合模式可能因此重复采集麦克风。应返回明确失败或让用户重新选择，不能悄悄更换输入。

get_segments 使用 SELECT *，详情接口直接返回包含潜在 WAV BLOB 的字典（database.py:236；main.py:62）。当前样本的 BLOB 为空，暂未触发问题；有实际二进制后应只通过独立音频端点读取，详情 JSON 返回元数据与资产引用。

管理页一次取最多 1000 条后在浏览器分页、过滤，随着数据增长会漏记录；应改为数据库分页与查询。笔记后端已有存储能力，但当前页面未将 textarea 接入 note 消息链路。

## 4. 协议是否应该升级

| 方案 | 对本项目的实际意义 | 建议 |
| --- | --- | --- |
| 保留 WebSocket | 改动小；便于后端统一接入多个云模型、存储与文件任务；仍需自己处理队列、恢复与音频 DSP | 第一阶段采用 |
| WebRTC 直连 | 浏览器原生媒体传输，有实时媒体处理能力；需要重新安排鉴权、业务事件、云端事件与存储通道 | 在弱网、双工和端到端延迟测试证明需要时做独立验证 |
| AOQ | 官方基于 QUIC 的 AI 实时协议；具备弱网与音频处理优势，但浏览器不原生支持，官方平台表列移动端 | Windows/Electron SDK 与接入路径验证通过后再决定，不作为当前依赖 |

依据官方协议表，Qwen-LiveTranslate-Realtime 支持以上三种传输。支持某协议不等于当前 Windows Electron 项目已有可直接替换的 SDK。[S3][S4]

如果 WebRTC 从 renderer 直连云端，Python 将不再处于媒体必经路径，但存储、任务和设置仍然存在；需要显式上报业务事件与录音，避免字幕、音频和历史记录出现两套事实来源。

换传输不能自动解决错误的消息关联、数据库落盘、虚拟声卡驱动、字幕时间轴或输出回采。先完成这些本地改造，再比较首个识别/译文/音频延迟、长尾延迟、弱网恢复与 CPU/内存，决定是否迁移。

## 5. 后续五类功能需要的最小架构变化

### 数据库与保存能力

继续使用 SQLite，保留 WAL、外键与已有的基础索引。重点增加 schema 迁移、独立会话、增量事务、任务状态和媒体资产文件。

最小数据结构：

- sessions：模式 live/file、开始/结束、状态、语言、provider/model/配置快照。
- segments：会话、稳定段落 ID、原文/译文、speaker_id、起止时间、完成状态、原始消息关联。
- assets：录音/译音/视频/字幕的路径、格式、采样率、声道、大小、时长；文件内容存文件系统。
- jobs：仅在文件翻译进入实现时增加；保存输入、进度、取消、失败与重试所需位置。
- settings：普通用户设置和模型配置；凭据存系统凭据设施，通过引用关联。

不需要现在部署 PostgreSQL、Redis、消息队列或向量数据库。单桌面应用的问题是数据流程，不是数据库承载力。

### 悬浮字幕

增加透明、置顶、可选择点击穿透的独立 BrowserWindow。主界面和悬浮窗订阅同一个标准化字幕状态；关闭主界面不应隐式销毁会话。需要明确用户关闭窗口、结束任务、隐藏字幕三种动作的差别。

会话不应继续寄存在某一个页面的 DOM、ws 对象和全局变量中。先把业务状态放到持久运行的后端/宿主协调层，再增加视图订阅。

### 虚拟声卡与音频路由

先支持用户已经安装的虚拟输入/输出设备，枚举音频输入和输出并配置播放设备。设备身份、输入路由、输出路由与增益分开保存。

系统声捕获优先使用受支持的 Electron 显示采集机制并验证 Windows loopback；若需要按进程排除自身声音或更精细路由，再做小范围原生能力验证。当前 Electron 文档的 loopback 仍有平台约束，不能直接假定全平台一致。[S8]

“使用已有虚拟声卡”和“自己开发安装虚拟声卡”是两种工作量。后者涉及系统音频驱动、安装和维护，不能靠新增一个前端模块实现。优先前者；Windows 官方 SysVAD 样例可用于理解自研驱动范围。[S9]

定义“模型听见什么”和“用户听见什么”，防止译音进入自己的输入环路；不能把麦克风上的 echoCancellation 约束当成系统回采隔离方案。

### 本地视频翻译

新增文件输入流程：文件选择 → 媒体探测/音轨抽取 → 分段处理 → 字幕时间轴 → SRT/VTT 导出。FFmpeg 是可验证的媒体处理候选，放在独立任务进程中管理进度、取消和错误；具体引入在开始实现此功能时决定。

“边播放边显示翻译”可以让文件音轨成为现有实时管线的新输入源；“导入后批量翻译并导出字幕/配音”应走文件任务，不宜强迫整段视频按照播放速度上传实时接口。

官方还提供 qwen3-livetranslate-flash 文件模型，经 OpenAI 兼容 Chat Completions 的流式接口调用。它与 realtime 模型的协议和语言能力不同；不能仅替换模型字符串共用解析器，也不能假定返回完整字幕时间轴。实现时需验证文件限制与时间信息，对长文件分段并保留原始时间偏移。[S5]

### 系统设置与多模型

先增加 provider/model 配置、地域与 endpoint、目标语言、输出模态、热词、音色、输入输出设备、录音位置。每次会话保存配置快照，避免用户修改设置后历史无法解释。

每个实际接入模型声明它能做什么：实时/文件、源语言自动检测/可指定、文本/音频、说话人、时间戳、音色、输入输出采样率、允许的目标语言。UI 依能力展示设置，不再把 TEXT_ONLY_LANGS 等规则当成所有模型的统一事实。

每家协议只负责把真实请求/事件转换为应用事件。先用函数与模块完成，第二个供应商落地后再提炼实际重复逻辑，不建设通用插件框架。

## 6. 技术栈建议

- Electron：保留，升级至实施时仍在支持期内的稳定版本。31.x 已结束支持，需要重点回归系统声采集、权限、多窗口与设备切换。[S6]
- 前端：先保留现有页面和可复用字幕渲染，逐步引入 TypeScript 来约束事件、会话和设置。React/Vue 并不是媒体可靠性或多窗口的必要条件。
- 音频：ScriptProcessor → AudioWorklet；独立采集、重采样、发送、播放职责；有界队列、连续时间基准和文件录音。
- Python：当前没有本地推理需求，但改写它也不会直接降低模型计算时延。第一阶段保留，把 FastAPI 从中继脚本改成明确的会话与任务入口。
- 单进程语言统一：如果产品长期仅做桌面且后续仍无 Python 专属依赖，可以单独评估把 WebSocket/SQLite 逻辑合入 Electron 的后台进程；收益主要是部署简化，代价是核心重写与 Node SQLite 打包验证。本轮不建议同时执行。
- 依赖：Python 当前 requirements 只有下限，需要锁定已验证版本。代码使用 additional_headers；websockets 12/13 的旧默认实现与 14+ 新实现存在接口差异，现有 websockets>=12 声明不准确。[S10]
- Python 版本：main.py 仍提示 3.8，但代码已有 list[str] 和 X | None 等新语法。应确定并验证一个实际支持的运行时版本，再同步启动检查和 README。
- 运行方式：Electron 管理后端启动、就绪检查和退出，向页面注入真实端口。当前 .env=1145、前端固定1145、后端默认8000存在三处配置来源；start.bat 同时拉起两进程但没有就绪等待。

目标责任划分：

~~~mermaid
flowchart TB
  Host[Electron 主进程<br/>窗口 / 生命周期 / 设备权限 / 配置注入] --> Views[主界面 / 悬浮字幕 / 历史 / 设置]
  Media[媒体处理模块<br/>采集 / 重采样 / 有界播放] --> Session[会话协调模块<br/>状态 / 消息关联 / 取消 / 收尾]
  Session --> Provider[当前模型协议模块]
  Provider --> Cloud[云端实时模型]
  Session --> Store[SQLite 元数据 + 媒体文件]
  Session --> Views
  Jobs[文件任务<br/>探测 / 解码 / 分段 / 时间轴] --> Session
~~~

图中是职责边界，不意味着每个框都要新建进程、服务或类。媒体处理放 AudioWorklet/Worker；会话与持久化在第一阶段由 Python 负责；Electron 主进程承担窗口与后端生命周期。

## 7. 推荐实施顺序与验收

| 阶段 | 交付内容 | 验收证据 |
| --- | --- | --- |
| 1 | 3.8 请求/事件适配、消息关联、停止收尾、独立会话、增量保存 | 同一段测试音频能得到完整原译文；文本与音频两种模式均可；最后一句保存；断连标记中断；重复停止不重复写入 |
| 2 | AudioWorklet、连续重采样、逐块PCM解码、有界队列、统一取消和设备路由 | 长时运行内存稳定；切源后原轨释放；暂停/恢复不重播旧音频；输出不回采 |
| 3 | Electron 支持版本升级、后端托管、统一配置、模型管理、悬浮字幕 | 冷启动无需手动开两个进程；主窗口与字幕一致；隐藏/关闭视图不误结束任务 |
| 4 | 本地视频任务、时间轴、取消/恢复、SRT/VTT 导出、虚拟设备集成 | 字幕与媒体时间对齐；重试无重复；设备路由可复现；失败有可恢复记录 |
| 5 | 需要时验证 WebRTC/AOQ 与更深入原生路由 | 与已修复 WS 基线同样音频、网络条件比较延迟、恢复、CPU/内存，证明收益再迁移 |

单独的 Electron 运行时升级可在阶段 1 后做，不要与云模型和采集实现全部混成一次不可定位的大改动。

## 8. 已执行验证与限制

- 静态阅读当前前后端、Electron、数据库与配置；核对官方页面。
- 对服务端 Python 文件执行 ast.parse，语法通过。
- 只读 SQLite 聚合统计，未修改记录。
- Base64 独立音频帧解码的最小复现。
- 当前环境安装版本：FastAPI 0.136.3、Uvicorn 0.49.0、websockets 16.0、python-dotenv 1.2.2；这些是环境事实，不是已经验证的发布依赖组合。
- 未启动应用进行真机采集/播放测试，未请求云端模型；因此尚不能量化改造后的延迟、准确率或费用变化。官方标称时延也不能当成本机的实测值。

## 官方来源

以下来源于 2026-10-28 查阅；模型能力和平台支持在实施时应复核。

- [S1 实时语音/音视频翻译：模型、接入、3.5/3.8 差异](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)
- [S2 实时翻译服务端事件](https://docs.bailian.console.aliyun.com/zh/model-studio/live-translator-server-events)
- [S3 Realtime API 协议与模型支持范围](https://docs.bailian.console.aliyun.com/zh/model-studio/realtime-api-overview)
- [S4 AOQ 接入](https://help.aliyun.com/zh/model-studio/realtime-aoq-access)
- [S5 音视频文件翻译](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen3-livetranslate-flash)
- [S6 Electron 发布与维护周期](https://releases.electronjs.org/schedule)
- [S7 Web Audio 标准：ScriptProcessorNode](https://www.w3.org/TR/webaudio/#the-scriptprocessornode-interface)
- [S8 Electron 显示媒体请求与 loopback](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [S9 Microsoft 虚拟音频设备与 SysVAD](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/virtual-audio-devices)
- [S10 websockets 新 asyncio 实现迁移](https://websockets.readthedocs.io/en/stable/howto/upgrade.html)
