"""千问同声传译 WebSocket 客户端封装"""

import asyncio
import json
import time
import base64
import traceback
from typing import Callable, Optional

import websockets

from config import DASHSCOPE_API_KEY, QWEN_WS_URL
from logger import get_logger

log = get_logger()


class QwenTranslator:
    """封装千问实时翻译 WebSocket 连接"""

    def __init__(
        self,
        target_language: str = "zh",
        source_language: str = "en",
        audio_enabled: bool = True,
        enable_asr: bool = True,
    ):
        if not DASHSCOPE_API_KEY:
            raise ValueError("DASHSCOPE_API_KEY 未设置，请检查 .env 文件")

        self.api_key = DASHSCOPE_API_KEY
        self.target_language = target_language
        self.source_language = source_language
        self.audio_enabled = audio_enabled
        self.enable_asr = enable_asr
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self._session_ready = asyncio.Event()
        self._session_finished = asyncio.Event()

    async def connect(self):
        """建立到千问翻译服务的 WebSocket 连接"""
        headers = {"Authorization": f"Bearer {self.api_key}"}

        log.info(f"连接千问服务: {QWEN_WS_URL}")
        log.info(f"请求头: Authorization=Bearer {self.api_key[:10]}...")

        self.ws = await websockets.connect(QWEN_WS_URL, additional_headers=headers)
        log.info("千问 WebSocket 已连接")

    async def configure_session(self):
        """配置翻译会话参数"""
        modalities = ["text"]  # 只请求文本输出，不请求音频

        session_config = {
            "modalities": modalities,
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "translation": {
                "language": self.target_language,
            },
        }

        if self.enable_asr:
            session_config["input_audio_transcription"] = {
                "model": "qwen3-asr-flash-realtime",
                "language": self.source_language,
            }

        config = {
            "event_id": f"event_{int(time.time() * 1000)}",
            "type": "session.update",
            "session": session_config,
        }

        log.api_send(f"session.update | 源语言={self.source_language} 目标语言={self.target_language} 模态={modalities}")
        log.api_send(f"完整配置: {json.dumps(config, indent=2, ensure_ascii=False)}")

        await self.ws.send(json.dumps(config))

        # 等待 session.created 和 session.updated
        for _ in range(2):
            msg = await asyncio.wait_for(self.ws.recv(), timeout=10)
            event = json.loads(msg)
            log.api_recv(f"{event.get('type')} | {json.dumps(event, ensure_ascii=False)[:200]}")
            if event.get("type") == "session.updated":
                self._session_ready.set()
                log.info("会话配置完成，已就绪")

    async def send_audio_chunk(self, audio_data: bytes):
        """发送音频数据块到千问服务"""
        if not self.ws:
            return

        b64 = base64.b64encode(audio_data).decode()

        event = {
            "event_id": f"event_{int(time.time() * 1000)}",
            "type": "input_audio_buffer.append",
            "audio": b64,
        }
        await self.ws.send(json.dumps(event))

    async def finish_session(self):
        """通知服务端音频发送完毕"""
        if not self.ws:
            return

        log.info("发送 session.finish")
        finish_event = {
            "event_id": f"event_{int(time.time() * 1000)}",
            "type": "session.finish",
        }
        await self.ws.send(json.dumps(finish_event))

        try:
            await asyncio.wait_for(self._session_finished.wait(), timeout=15)
        except asyncio.TimeoutError:
            log.warn("等待 session.finished 超时")

    async def receive_events(self, on_event: Callable):
        """循环接收服务端事件，通过回调函数分发"""
        try:
            async for raw_message in self.ws:
                event = json.loads(raw_message)
                event_type = event.get("type", "")

                # 打印完整事件JSON
                log.api_recv(f"{event_type} | 完整事件: {json.dumps(event, indent=2, ensure_ascii=False)}")

                if event_type == "session.finished":
                    self._session_finished.set()
                    await on_event({"type": "session_end"})
                    break

                elif event_type == "input_audio_buffer.speech_started":
                    await on_event({"type": "speech_started"})

                elif event_type == "input_audio_buffer.speech_stopped":
                    await on_event({"type": "speech_stopped"})

                elif event_type == "conversation.item.created":
                    await on_event({"type": "item_created"})

                elif event_type == "response.created":
                    await on_event({"type": "response_created"})

                elif event_type == "conversation.item.input_audio_transcription.text":
                    # 文档说明: text=已确认文本, stash=待确认文本
                    confirmed = event.get("text", "")
                    stash = event.get("stash", "")
                    await on_event({
                        "type": "source_text_delta",
                        "confirmed": confirmed,
                        "stash": stash,
                    })

                elif event_type == "conversation.item.input_audio_transcription.completed":
                    text = event.get("transcript", "")
                    if text:
                        await on_event({
                            "type": "source_text_final",
                            "text": text,
                        })

                elif event_type == "response.text.text":
                    # 文档说明: text=已确认翻译文本, stash=待确认翻译文本
                    confirmed = event.get("text", "")
                    stash = event.get("stash", "")
                    await on_event({
                        "type": "translation_delta",
                        "confirmed": confirmed,
                        "stash": stash,
                    })

                elif event_type == "response.text.done":
                    text = event.get("text", "")
                    if text:
                        await on_event({
                            "type": "translation_final",
                            "text": text,
                        })

                elif event_type == "response.audio.delta":
                    audio_b64 = event.get("delta", "")
                    if audio_b64:
                        await on_event({
                            "type": "audio_delta",
                            "audio": audio_b64,
                        })

                elif event_type == "response.done":
                    # 提取最终翻译文本
                    response = event.get("response", {})
                    output = response.get("output", [])
                    final_text = ""
                    if output and len(output) > 0:
                        content = output[0].get("content", [])
                        if content and len(content) > 0:
                            final_text = content[0].get("text", "")
                    usage = response.get("usage", {})
                    await on_event({
                        "type": "response_done",
                        "text": final_text,
                        "usage": usage,
                    })

                elif event_type == "error":
                    log.error(f"千问服务端错误: {event.get('message', '未知')}")
                    await on_event({
                        "type": "error",
                        "message": event.get("message", "未知错误"),
                    })

        except websockets.exceptions.ConnectionClosed as e:
            log.warn(f"千问连接关闭: code={e.code} reason={e.reason}")
            await on_event({"type": "connection_closed", "reason": str(e)})
        except Exception as e:
            log.error(f"接收事件异常: {e}")
            traceback.print_exc()
            await on_event({"type": "error", "message": str(e)})

    def _event_preview(self, event: dict) -> str:
        """构建事件内容预览"""
        if "text" in event:
            t = event["text"]
            return t[:80] + ("..." if len(t) > 80 else "")
        if "transcript" in event:
            t = event["transcript"]
            return t[:80] + ("..." if len(t) > 80 else "")
        if "stash" in event:
            t = event["stash"]
            return t[:80] + ("..." if len(t) > 80 else "")
        if "delta" in event:
            return f"[音频 {len(event['delta'])} chars]"
        if "usage" in event:
            return json.dumps(event["usage"], ensure_ascii=False)
        return json.dumps(event, ensure_ascii=False)[:200]

    async def close(self):
        """关闭连接"""
        if self.ws:
            await self.ws.close()
            self.ws = None
            log.info("千问连接已关闭")