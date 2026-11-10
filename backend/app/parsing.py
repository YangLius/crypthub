"""解析器（设计 5.1）：md/txt/csv/代码原生读；pdf=PyMuPDF；docx=python-docx。"""
from __future__ import annotations

import io


class ParseError(Exception):
    pass


def parse_pdf(data: bytes) -> str:
    try:
        import fitz  # PyMuPDF
    except ImportError as e:  # pragma: no cover
        raise ParseError("未安装 PyMuPDF") from e
    parts: list[str] = []
    with fitz.open(stream=data, filetype="pdf") as doc:
        for i in range(doc.page_count):
            page = doc.load_page(i)
            txt = page.get_text("text").strip()
            if txt:
                parts.append(f"### 第{i + 1}页\n{txt}")
    if not parts:
        raise ParseError("PDF 无可提取文本（可能为扫描件；OCR 未启用）")
    return "\n\n".join(parts)


def parse_docx(data: bytes) -> str:
    try:
        import docx  # python-docx
    except ImportError as e:  # pragma: no cover
        raise ParseError("未安装 python-docx") from e
    d = docx.Document(io.BytesIO(data))
    parts: list[str] = []
    for p in d.paragraphs:
        t = p.text.rstrip()
        if not t:
            continue
        style = (getattr(p.style, "name", "") or "").lower()
        if style.startswith("heading"):
            try:
                level = int(style.replace("heading", "").strip() or "2")
            except ValueError:
                level = 2
            parts.append(f"{'#' * min(level, 6)} {t}")
        else:
            parts.append(t)
    # 表格按行拼为管道分隔文本
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip().replace("\n", " ") for c in row.cells]
            if any(cells):
                parts.append("| " + " | ".join(cells) + " |")
    if not parts:
        raise ParseError("docx 无可提取文本")
    return "\n".join(parts)


def parse_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return data.decode("gb18030")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")


def parse_ocr(data: bytes) -> str:
    if not __import__("app.config", fromlist=["settings"]).settings.ocr_enabled:
        raise ParseError("图片 OCR 未启用（M1 默认关闭）")
    raise ParseError("OCR 未配置")  # pragma: no cover


def extract(data: bytes, filename: str, mime: str) -> str:
    name = filename.lower()
    if name.endswith(".pdf") or mime == "application/pdf":
        return parse_pdf(data)
    if name.endswith(".docx") or mime in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",):
        return parse_docx(data)
    if name.endswith(".doc") or mime == "application/msword":
        raise ParseError("暂不支持旧版 .doc，请另存为 .docx")
    if name.endswith((".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff")) or mime.startswith("image/"):
        return parse_ocr(data)
    return parse_text(data)
