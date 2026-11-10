"""索引任务队列（Redis List，worker 消费）。"""
from __future__ import annotations

import json
import uuid

from . import security

TASK_KEY = "kb:tasks"


async def enqueue_index(doc_id: str) -> str:
    task_id = uuid.uuid4().hex
    await security.redis_client().rpush(
        TASK_KEY, json.dumps({"task_id": task_id, "type": "index", "doc_id": doc_id}))
    return task_id
