"""单测：分块（设计 5.3 —— 标题/函数边界优先，400–800 字，重叠 10%）。"""

from app.chunking import chunk_text


def test_basic_chunking_size_bounds():
    text = "\n".join(f"第{i}段。" + "内容" * 120 for i in range(12))
    chunks = chunk_text(text)
    assert chunks, "应产生至少一个分块"
    for c in chunks:
        assert len(c.text) <= 800, f"分块超长: {len(c.text)}"


def test_heading_anchor_boundaries():
    text = "# 部署指南\n" + "正文A" * 300 + "\n\n# 回滚手册\n" + "正文B" * 300
    chunks = chunk_text(text)
    anchors = {c.anchor for c in chunks}
    assert "部署指南" in anchors or any("部署" in a for a in anchors)
    assert any("回滚" in a for a in anchors)


def test_overlap_between_chunks():
    body = "字符" * 2000  # 单元超长 → 硬切路径
    chunks = chunk_text(body)
    assert len(chunks) >= 2
    # 相邻块存在重叠（前一块尾出现在后一块头）
    for a, b in zip(chunks, chunks[1:], strict=False):
        tail = a.text[-60:]
        assert b.text[:120].find(tail[-40:]) != -1 or a.text[-40:] in b.text[:200]


def test_function_boundary_split():
    funcs = "\n\n".join(
        f"def handle_{i}(x):\n    'step {i}'\n    return x * {i}\n"
        + "# 注释填充\n" * 30
        for i in range(10)
    )
    chunks = chunk_text(funcs)
    assert len(chunks) >= 1
    for c in chunks:
        assert len(c.text) <= 800


def test_short_text_single_chunk():
    chunks = chunk_text("短内容")
    # 极短文本要么不产生块（<20字符过滤），要么单块
    assert len(chunks) <= 1


def test_idx_sequential():
    text = "\n".join(f"# 标题{i}\n" + "字" * 500 for i in range(6))
    chunks = chunk_text(text)
    assert [c.idx for c in chunks] == list(range(len(chunks)))
