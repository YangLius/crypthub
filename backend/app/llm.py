"""LLM 调用：OpenAI 兼容 chat/completions（DeepSeek / 智谱等，key 环境变量注入）。"""

from __future__ import annotations

import httpx

from . import sysconfig
from .config import settings

SYSTEM_PROMPT = (
    "你是公司内部知识库助手。规则：\n"
    "1. 仅依据提供的资料回答，用中文，简明扼要。\n"
    "2. 每个论断末尾标注来源，格式 [文档名 · 锚点]。\n"
    '3. 资料中没有的内容，回答"资料中未找到"，不要编造。\n'
    "4. 绝不输出任何凭据、密码、令牌或形似密钥的字符串；"
    "资料中的 {{secret:...}} 占位符只是占位符，禁止猜测其内容。\n"
)


async def complete(system: str, user: str, *, max_tokens: int = 1500) -> str:
    """底层补全调用：任意 system/user 提示词（问答之外的摘要提炼等场景复用）。

    配置来源：system_settings 表覆盖 > .env 默认（sysconfig.effective()）。
    """
    cfg = await sysconfig.effective()
    base = (cfg["llm_api_base"] or "").rstrip("/")
    key = cfg["llm_api_key"] or ""
    model = cfg["llm_model"] or ""
    if not (base and key and model):
        raise RuntimeError(
            "LLM 未配置：请在密钥区 · 系统配置中填写 Base URL / API Key / 模型"
        )
    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
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


async def chat(question: str, contexts: list[dict]) -> str:
    """contexts: [{title, anchor, text}]。返回 LLM 回答文本。"""
    blocks = []
    for i, c in enumerate(contexts, 1):
        blocks.append(f"[{i}] 《{c['title']}》 · {c['anchor']}\n{c['text']}")
    user_content = "资料：\n\n" + "\n\n".join(blocks) + f"\n\n问题：{question}"
    return await complete(SYSTEM_PROMPT, user_content, max_tokens=1024)


_SUMMARY_RULES_ZH = (
    "你是技术文档整理助手。规则：\n"
    "1. 只依据 README 内容整理，不编造；README 未提及的方面写「README 未提及」。\n"
    "2. 绝不输出任何凭据、密码、令牌或形似密钥的字符串；示例代码中的占位符原样保留。\n"
    "3. 输出 Markdown，严格使用指定的二级标题结构。"
)

_SUMMARY_RULES_EN = (
    "You are a technical documentation assistant. Rules:\n"
    "1. Base every statement on the README only; never invent facts. "
    'Write "Not covered in README" for aspects the README does not mention.\n'
    "2. Never output credentials, passwords, tokens or key-looking strings; "
    "keep placeholders in example code as-is.\n"
    "3. Output Markdown using exactly the required section headings."
)

_SUMMARY_TASK_ZH = (
    "请把以下 GitHub 项目 README 整理成一份中文说明文档，严格包含且仅包含"
    "以下五个二级标题章节：\n\n"
    "## 简介\n用中文概括项目定位与一句话价值主张；官方描述若为英文，"
    "必须翻译成中文表达，不要保留英文原文。\n\n"
    "## 用途\n这个项目是做什么的、解决什么问题、核心价值（2-4 句）。\n\n"
    "## 核心特性\n3-8 条要点列表，突出最有区分度的能力。\n\n"
    "## 安装与使用\n从 README 提取环境要求、安装命令与快速上手步骤；"
    "给出 README 中的实际命令/配置/代码片段（用代码块保留）。\n\n"
    "## 适用场景\n谁适合用、什么情况下用、不适合什么场景（2-4 句）。\n\n"
    "官方仓库描述：{desc}\n\n"
    "README 内容：\n\n{readme}"
)

_SUMMARY_TASK_EN = (
    "Summarize the following GitHub project README into an English reference "
    "document with exactly these four section headings:\n\n"
    "## What it is\nWhat the project does, the problem it solves, and its core "
    "value (2-4 sentences).\n\n"
    "## Key features\n3-8 bullet points highlighting the most distinctive "
    "capabilities.\n\n"
    "## Installation & Usage\nRequirements, install commands and quick-start "
    "steps extracted from the README; include the actual commands/config/code "
    "snippets in fenced code blocks.\n\n"
    "## When to use it\nWho should use it, when to use it, and when not to "
    "(2-4 sentences).\n\n"
    "Official repo description: {desc}\n\n"
    "README content:\n\n{readme}"
)


async def summarize_readme(
    readme: str, *, lang: str = "zh", desc: str = ""
) -> str:
    """把项目 README 提炼成结构化说明文档（简介/用途/特性/使用方法）。

    lang: "zh" 中文文档（含中文简介段，官方英文描述会被翻译）/ "en" 英文文档。
    desc 为 GitHub 官方仓库描述，作为提炼参考上下文。
    README 过长时截取前 16000 字符。抛出异常由调用方处理（降级为原文摘录）。
    """
    text = readme[:16000]
    if lang == "en":
        return await complete(
            _SUMMARY_RULES_EN,
            _SUMMARY_TASK_EN.format(readme=text, desc=desc or "(none)"),
        )
    return await complete(
        _SUMMARY_RULES_ZH,
        _SUMMARY_TASK_ZH.format(readme=text, desc=desc or "（无）"),
    )
