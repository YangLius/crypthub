"""本地开发用 Redis 替身：fakeredis TCP 服务器（redis-py 直接兼容）。

用法：python scripts/dev_redis.py   # 监听 127.0.0.1:6390
仅用于无 docker/Redis 的本机开发；生产部署用 docker-compose 里的真 Redis。
"""

from __future__ import annotations

import signal
import sys

from fakeredis import TcpFakeServer


def main() -> None:
    host, port = "127.0.0.1", 6390
    server = TcpFakeServer((host, port), server_type="redis")
    print(f"[dev_redis] fakeredis 监听 {host}:{port}（Ctrl+C 退出）", flush=True)

    def _stop(*_: object) -> None:
        server.shutdown()
        server.server_close()
        sys.exit(0)

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    server.serve_forever()


if __name__ == "__main__":
    main()
