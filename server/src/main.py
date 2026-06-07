"""FastAPI 服务端 - WebSocket 中继 + 静态文件服务"""

import asyncio
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import SERVER_PORT
from translator import QwenTranslator
from logger import get_logger

log = get_logger()


# ============ 应用生命周期 ============

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(f"服务端已启动 | http://localhost:{SERVER_PORT}")
    yield


app = FastAPI(title="AI 同声传译助手", lifespan=lifespan)

# 前端静态文件目录
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "app")

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


# ============ WebSocket 中继 ============

@app.websocket("/ws/translate")
async def translate_websocket(client_ws: WebSocket):
    await client_ws.accept()
    log.info("浏览器 WebSocket 已连接")

    translator: QwenTranslator | None = None
    translator_task: asyncio.Task | None = None
    event_queue: asyncio.Queue = asyncio.Queue()
    is_paused = False

    async def forward_to_client():
        try:
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                try:
                    await client_ws.send_json(event)
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    forward_task = asyncio.create_task(forward_to_client())

    try:
        raw = await client_ws.receive_text()
        config = json.loads(raw)

        if config.get("type") != "start":
            await client_ws.send_json({"type": "error", "message": "第一条消息必须是 start 类型"})
            return

        source_lang = config.get("source_language", "en")
        target_lang = config.get("target_language", "zh")
        audio_enabled = config.get("audio_enabled", True)
        corpus = config.get("corpus")

        log.info(f"开始翻译: {source_lang} → {target_lang}, 音频={'开' if audio_enabled else '关'}")

        translator = QwenTranslator(
            target_language=target_lang,
            source_language=source_lang,
            audio_enabled=audio_enabled,
            enable_asr=True,
            corpus=corpus,
        )

        await translator.connect()
        await translator.configure_session()

        await client_ws.send_json({"type": "ready"})

        async def qwen_event_handler(event: dict):
            await event_queue.put(event)

        translator_task = asyncio.create_task(translator.receive_events(qwen_event_handler))

        chunk_count = 0
        while True:
            try:
                msg = await client_ws.receive()
                if msg.get("type") == "websocket.receive":
                    data = msg.get("bytes")
                    text = msg.get("text")

                    if text:
                        # 处理控制消息
                        try:
                            ctrl = json.loads(text)
                            ctrl_type = ctrl.get("type")
                            if ctrl_type == "pause":
                                log.info("收到暂停信号，发送 session.finish")
                                is_paused = True
                                await translator.finish_session()
                                await client_ws.send_json({"type": "paused"})
                                continue
                            elif ctrl_type == "resume":
                                log.info("收到恢复信号，重置会话状态")
                                is_paused = False
                                await translator.reset_session()
                                await client_ws.send_json({"type": "resumed"})
                                continue
                        except Exception:
                            pass

                    if data and not is_paused:
                        chunk_count += 1
                        await translator.send_audio_chunk(data)

            except WebSocketDisconnect:
                log.info(f"浏览器断开连接 (共接收 {chunk_count} 个音频块)")
                break

    except WebSocketDisconnect:
        log.info("浏览器断开连接")
    except Exception as e:
        log.error(f"服务端异常: {e}")
        try:
            await client_ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        if translator:
            try:
                await translator.finish_session()
            except Exception:
                pass

        if translator_task and not translator_task.done():
            translator_task.cancel()
            try:
                await translator_task
            except asyncio.CancelledError:
                pass

        if translator:
            await translator.close()

        await event_queue.put(None)
        forward_task.cancel()
        try:
            await forward_task
        except asyncio.CancelledError:
            pass

        log.info("翻译会话结束")


# ============ 启动入口 ============

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=SERVER_PORT,
        reload=False,
        log_level="info",
    )