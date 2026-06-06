"""文件日志系统 - 所有日志保存到 logs/ 目录"""

import os
import sys
from datetime import datetime


class Logger:
    """同时输出到终端和文件的日志器"""

    def __init__(self):
        # 确保 logs 目录存在
        self.log_dir = os.path.join(os.path.dirname(__file__), "..", "logs")
        os.makedirs(self.log_dir, exist_ok=True)

        # 按日期创建日志文件
        date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = os.path.join(self.log_dir, f"session_{date_str}.log")
        self._file = None

    def _ensure_file(self):
        if self._file is None:
            self._file = open(self.log_path, "a", encoding="utf-8")

    def _write(self, level: str, msg: str):
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{timestamp}] [{level}] {msg}"
        print(line)
        self._ensure_file()
        self._file.write(line + "\n")
        self._file.flush()

    def info(self, msg: str):
        self._write("INFO", msg)

    def debug(self, msg: str):
        self._write("DEBUG", msg)

    def warn(self, msg: str):
        self._write("WARN", msg)

    def error(self, msg: str):
        self._write("ERROR", msg)

    def api_send(self, msg: str):
        self._write("API→", msg)

    def api_recv(self, msg: str):
        self._write("API←", msg)

    def close(self):
        if self._file:
            self._file.write(f"\n[{datetime.now().strftime('%H:%M:%S')}] 会话结束\n")
            self._file.close()
            self._file = None


# 全局单例
_logger = None


def get_logger() -> Logger:
    global _logger
    if _logger is None:
        _logger = Logger()
    return _logger