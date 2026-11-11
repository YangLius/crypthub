"""单测：脱敏闸规则（对应设计第 6 节入库闸规则集）。"""

from app import gates


def test_prefix_hit():
    text = "使用 sk-Abcd1234567890abcdef1234 作为 API key"
    hits = gates.scan(text)
    assert any(h.kind == "prefix" for h in hits)


def test_prefix_private_key_block():
    text = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----"
    hits = gates.scan(text)
    assert any(h.kind == "prefix" for h in hits)


def test_prefix_aws():
    hits = gates.scan("aws_secret_access_key = AKIAIOSFODNN7EXAMPLEEXTRA")
    kinds = {h.kind for h in hits}
    assert "prefix" in kinds  # AKIA 前缀


def test_connstr_hit():
    text = "DATABASE_URL=postgres://admin:P@ssw0rd123@db.internal:5432/kb"
    hits = gates.scan(text)
    assert any(h.kind == "connstr" for h in hits)


def test_connstr_redis():
    hits = gates.scan("redis://default:cachePass99@rds:6379/0")
    assert any(h.kind == "connstr" for h in hits)


def test_kv_hit():
    hits = gates.scan("password: hunter2secret")
    assert any(h.kind == "kv" for h in hits)
    hits2 = gates.scan('api_key = "abcd1234"')
    assert any(h.kind == "kv" for h in hits2)


def test_kv_no_false_positive_on_short_value():
    assert not any(h.kind == "kv" for h in gates.scan("password=ab"))


def test_entropy_hit():
    tok = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"  # 前缀规则优先命中
    text = f"token: {tok}"
    hits = gates.scan(text)
    # token 也是 kv 关键字：命中发生即可，且必须覆盖 ghp_ 串
    assert hits and tok in text[hits[0].start : hits[0].end]
    # 纯高熵（无前缀）
    hits2 = gates.scan("signature: Xk9pQ2rS7tU8vW3xY4zA5bC6dE7fG8h")
    assert any(h.kind == "entropy" for h in hits2)


def test_entropy_no_hit_for_english_word():
    # 长英文单词不应被当凭据（服务端 strict 模式要求字母+数字混用）
    assert not any(
        h.kind == "entropy"
        for h in gates.scan("internationalization constant", strict=True)
    )


def test_normal_text_clean():
    text = "这是一段普通的文档内容，包含中文和数字 12345，不应命中任何规则。"
    assert gates.scan(text) == []


def test_placeholder_not_rehit():
    """脱敏后的占位符不会被再次命中（幂等，服务端兜底扫描安全）。"""
    rd = gates.redact("password: Sup3rSecret!Value")
    assert rd.pending
    second = gates.scan(rd.text)
    assert not any(h.kind == "kv" for h in second)


def test_redact_replacement_and_order():
    text = "db=postgres://u:pwd@h/x and token: aB3xK9mQ7wR5tY2uI6oP4aS8dF1gH0zZ and password: letmein99"
    rd = gates.redact(text)
    assert "{{secret:" in rd.text
    assert "postgres://u:pwd@h/x" not in rd.text
    assert "letmein99" not in rd.text
    # 占位符按命中顺序排列
    slugs = [p["slug"] for p in rd.pending]
    for i, slug in enumerate(slugs):
        assert rd.text.index("{{secret:" + slug + "}}") < (
            rd.text.index("{{secret:" + slugs[i + 1] + "}}")
            if i + 1 < len(slugs)
            else 10**9
        )


def test_no_overlap_duplicates():
    text = "secret: sk-Abcd1234567890abcdef1234"
    hits = gates.scan(text)
    starts = sorted(h.start for h in hits)
    for a, b in zip(starts, starts[1:], strict=False):
        assert a < b


def test_is_text_mime():
    assert gates.is_text_mime("text/plain", "a.txt")
    assert gates.is_text_mime("application/json", "a.json")
    assert gates.is_text_mime("", "readme.md")
    assert gates.is_text_mime("application/octet-stream", "a.py")
    assert not gates.is_text_mime("application/pdf", "a.pdf")
