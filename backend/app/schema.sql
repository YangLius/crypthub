-- 私有知识库与密钥管理系统 — 后端
-- 运行时以本文件为准（与 docs/02-数据库DDL.sql 内容保持同步，docs 侧为评审/存档用途）。
-- 注：实现偏差——不依赖 pgvector 扩展（目标库可能未安装），embedding 存 real[]，
-- 向量检索为 Python 侧精确余弦扫描（设计本就不建 ANN 索引，百级文档规模适用）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL UNIQUE,
    display_name  text NOT NULL DEFAULT '',
    role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
    salt_auth     bytea,
    salt_enc      bytea,
    auth_verifier text,
    local_check_ct text,
    setup_token_hash bytea,
    setup_token_expires timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_keys (
    user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key     text NOT NULL,
    priv_wrapped   text NOT NULL,
    rk_salt        bytea  NOT NULL,
    priv_rk_wrapped text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_recovery (
    id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_key    text NOT NULL,
    offline_salt  bytea NOT NULL,
    org_priv_offline_wrapped text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    rotated_at    timestamptz
);

CREATE TABLE IF NOT EXISTS org_recovery_delegates (
    admin_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sealed        text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    project     text NOT NULL DEFAULT '',
    env         text NOT NULL DEFAULT '',
    tags        jsonb NOT NULL DEFAULT '[]',
    content_ct  text NOT NULL,
    dek_wrapped_org text NOT NULL,
    version     integer NOT NULL DEFAULT 1,
    owner_id    uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_secrets_owner ON secrets(owner_id);
CREATE INDEX IF NOT EXISTS idx_secrets_project ON secrets(project);

CREATE TABLE IF NOT EXISTS secret_grants (
    id          bigserial PRIMARY KEY,
    secret_id   uuid NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_dek text NOT NULL,
    granted_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (secret_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON secret_grants(user_id);

CREATE TABLE IF NOT EXISTS secret_versions (
    id          bigserial PRIMARY KEY,
    secret_id   uuid NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    version     integer NOT NULL,
    content_ct  text NOT NULL,
    wrapped_deks jsonb NOT NULL DEFAULT '{}',
    rotated_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_versions_secret ON secret_versions(secret_id, version);

CREATE TABLE IF NOT EXISTS documents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title       text NOT NULL,
    filename    text NOT NULL DEFAULT '',
    mime        text NOT NULL DEFAULT '',
    size_bytes  bigint NOT NULL DEFAULT 0,
    sha256      text NOT NULL,
    file_path   text NOT NULL DEFAULT '',
    project     text NOT NULL DEFAULT '',
    tags        jsonb NOT NULL DEFAULT '[]',
    secret_ref  uuid,
    status      text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','failed')),
    error       text,
    chunk_count integer NOT NULL DEFAULT 0,
    uploaded_by uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project);

CREATE TABLE IF NOT EXISTS chunks (
    id           bigserial PRIMARY KEY,
    document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    idx          integer NOT NULL,
    anchor       text NOT NULL DEFAULT '',
    text         text NOT NULL,
    tsv          tsvector,
    embedding    real[],
    dim          integer,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, idx);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm ON chunks USING gin(text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS pending_secrets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,
    kind        text NOT NULL DEFAULT '',
    source_doc_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    source_hint text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','dismissed')),
    claimed_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
    created_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id          bigserial PRIMARY KEY,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    username    text NOT NULL DEFAULT '',
    action      text NOT NULL,
    target_type text NOT NULL DEFAULT '',
    target_id   text NOT NULL DEFAULT '',
    ip          text NOT NULL DEFAULT '',
    reason      text NOT NULL DEFAULT '',
    detail      jsonb NOT NULL DEFAULT '{}',
    severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','alert')),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        text NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}',
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS groups (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_members (
    group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);
