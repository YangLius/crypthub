"""LLM 调用：OpenAI 兼容 chat/completions（DeepSeek / 智谱等，key 环境变量注入）。"""

from __future__ import annotations

import httpx

from .config import settings

SYSTEM_PROMPT = (
    "你是公司内部知识库助手。规则：\n"
    "1. 仅依据提供的资料回答，用中文，简明扼要。\n"
    "2. 每个论断末尾标注来源，格式 [文档名 · 锚点]。\n"
    '3. 资料中没有的内容，回答"资料中未找到"，不要编造。\n'
    "4. 绝不输出任何凭据、密码、令牌或形似密钥的字符串；"
    "资料中的 {{secret:...}} 占位符只是占位符，禁止猜测其内容。\n"
)


async def chat(question: str, contexts: list[dict]) -> str:
    """contexts: [{title, anchor, text}]。返回 LLM 回答文本。"""
    base, key, model = settings.require_llm()
    blocks = []
    for i, c in enumerate(contexts, 1):
        blocks.append(f"[{i}] 《{c['title']}》 · {c['anchor']}\n{c['text']}")
    user_content = "资料：\n\n" + "\n\n".join(blocks) + f"\n\n问题：{question}"
    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
    }
    headers = {"Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
        resp = await client.post(
            f"{base}/chat/completions", headers=headers, json=payload
        )
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]
