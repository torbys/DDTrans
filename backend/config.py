"""配置管理模块 - 从环境变量读取敏感信息"""

import os
from dotenv import load_dotenv

# 加载项目根目录的 .env 文件
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# 千问 API 配置
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
QWEN_WS_URL = os.getenv(
    "QWEN_WS_URL",
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime",
)

# 豆包 API 配置（备用）
VOLC_API_KEY = os.getenv("VOLC_API_KEY", "")

# 服务配置
SERVER_PORT = int(os.getenv("SERVER_PORT", "8000"))