-- ============================================================
-- 私有知识库与密钥管理系统 — 数据库 DDL（实现版）
-- 依据：《开发文档与密钥管理系统-设计方案v1.1》第 7 节数据模型
-- 目标库：PostgreSQL 16+（实现偏差：不依赖 pgvector 扩展——目标库可能未安装；
--   embedding 存 real[]，向量检索为 Python 侧精确余弦扫描，与运行时 schema.sql 保持一致）
-- 本文件由 api 启动时幂等执行（CREATE TABLE IF NOT EXISTS），
-- 同时作为数据库结构的唯一权威来源（与 docs 同步维护）。
--
-- 加密域说明（对应设计 4.1 / 7）：
--   * users / secrets / grants 等表只存密文与校验值，服务端不可解；
--   * documents / chunks 存"已脱敏"明文（凭证值在入库前被替换为
--     {{secret:slug}} 占位符，真实值只存在前端内存里）；
--   * audit_logs 只记动作，绝不记内容。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 账号与密钥层级 ----------

-- 用户：两个独立 salt；auth_verifier = HKDF(authKey) 校验值（服务端只见此值，
-- 无法反推 encKey）；local_check_ct = encKey 加密的本地校验串（解锁用）。
CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL UNIQUE,
    display_name  text NOT NULL DEFAULT '',
    role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
    salt_auth     bytea,                -- 派生 authKey 的 salt（注册时客户端生成）
    salt_enc      bytea,                -- 派生 encKey 的 salt（与 salt_auth 独立）
    auth_verifier text,                 -- 32 字节 hex；服务端比对 HMAC 挑战用
    local_check_ct text,                -- b64 密文：AES-256-GCM(encKey, "vault-check-v1")
    setup_token_hash bytea,             -- 开号令牌哈希（pending 状态下完成注册用）
    setup_token_expires timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 每人一把 X25519：公钥明文；私钥两份包装（encKey / 个人恢复码 RK）
CREATE TABLE IF NOT EXISTS user_keys (
    user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key     text NOT NULL,             -- 32 字节 b64
    priv_wrapped   text NOT NULL,             -- b64：AES-256-GCM(encKey, priv, aad=user-priv:<uid>)
    rk_salt        bytea  NOT NULL,           -- 个人恢复码 KDF salt
    priv_rk_wrapped text NOT NULL,            -- b64：AES-256-GCM(KDF(RK,rk_salt), priv, aad=user-priv-rk:<uid>)
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- 组织恢复密钥（单行，id=1）。org 私钥的"离线恢复码"包装副本存这里；
-- "管理员 encKey/私钥"包装副本按管理员逐人存 org_recovery_delegates。
CREATE TABLE IF NOT EXISTS org_recovery (
    id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_key    text NOT NULL,              -- 组织 X25519 公钥，b64
    offline_salt  bytea NOT NULL,             -- 离线恢复码 KDF salt
    org_priv_offline_wrapped text NOT NULL,   -- b64：AES-256-GCM(KDF(离线码,offline_salt), org_priv)
    created_at    timestamptz NOT NULL DEFAULT now(),
    rotated_at    timestamptz
);

-- 组织私钥用各管理员公钥非对称再包一份（管理员可在应用内代为恢复）
CREATE TABLE IF NOT EXISTS org_recovery_delegates (
    admin_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sealed        text NOT NULL,              -- ECIES(admin_pub, org_priv)
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- 密钥区（服务端只搬密文） ----------

-- 条目：名称/项目/环境/标签为明文（设计 4.3 的取舍），内容为密文。
CREATE TABLE IF NOT EXISTS secrets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    project     text NOT NULL DEFAULT '',
    env         text NOT NULL DEFAULT '',     -- prod / staging / dev ...
    tags        jsonb NOT NULL DEFAULT '[]',  -- ["redis","生产"]
    content_ct  text NOT NULL,                -- b64：AES-256-GCM(DEK, 内容JSON, aad=secret:<id>)
    dek_wrapped_org text NOT NULL,            -- b64：ECIES(org_pub, DEK) —— 组织恢复通道
    version     integer NOT NULL DEFAULT 1,
    owner_id    uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_secrets_owner ON secrets(owner_id);
CREATE INDEX IF NOT EXISTS idx_secrets_project ON secrets(project);

-- 授权：每条密钥 × 每个有权访问者 = 一行（创建者也在内），存"其公钥包装的 DEK"
CREATE TABLE IF NOT EXISTS secret_grants (
    id          bigserial PRIMARY KEY,
    secret_id   uuid NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_dek text NOT NULL,                -- b64：ECIES(user_pub, DEK)
    granted_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (secret_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON secret_grants(user_id);

-- 轮换历史：旧密文与当时的逐人包装（明文永不回库）
CREATE TABLE IF NOT EXISTS secret_versions (
    id          bigserial PRIMARY KEY,
    secret_id   uuid NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    version     integer NOT NULL,
    content_ct  text NOT NULL,
    wrapped_deks jsonb NOT NULL DEFAULT '{}', -- {user_id: sealed_dek}
    rotated_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_versions_secret ON secret_versions(secret_id, version);

-- ---------- 文档区（已脱敏明文 + 向量） ----------

CREATE TABLE IF NOT EXISTS documents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title       text NOT NULL,
    filename    text NOT NULL DEFAULT '',
    mime        text NOT NULL DEFAULT '',
    size_bytes  bigint NOT NULL DEFAULT 0,
    sha256      text NOT NULL,
    file_path   text NOT NULL DEFAULT '',     -- 原始文件相对路径（存储卷内）
    project     text NOT NULL DEFAULT '',
    tags        jsonb NOT NULL DEFAULT '[]',
    secret_ref  uuid,                         -- 指向 secrets.id（无外键约束，避免循环依赖）
    status      text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','failed')),
    error       text,
    chunk_count integer NOT NULL DEFAULT 0,
    uploaded_by uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project);

-- 片段：文本已脱敏；tsv 为 jieba 预分词（keyword 召回），embedding 为语义召回。
-- 向量列不固定维度：本地 bge-small(512) 与 API embedding(如 1024) 均可存；
-- 当前数据量（百级文档）用精确余弦扫描，不建 ANN 索引。
CREATE TABLE IF NOT EXISTS chunks (
    id           bigserial PRIMARY KEY,
    document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    idx          integer NOT NULL,
    anchor       text NOT NULL DEFAULT '',    -- 标题/函数等锚点
    text         text NOT NULL,
    tsv          tsvector,
    embedding    real[],                       -- 512 维 float 数组（无 pgvector 方案）
    dim          integer,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, idx);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm ON chunks USING gin(text gin_trgm_ops);

-- 脱敏产生的待认领占位符（真实值只在当时前端内存里）
CREATE TABLE IF NOT EXISTS pending_secrets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,         -- {{secret:<slug>}} 中的 slug
    kind        text NOT NULL DEFAULT '',     -- 命中规则类别：prefix/connstr/kv/high-entropy
    source_doc_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    source_hint text NOT NULL DEFAULT '',     -- 所在文档标题/片段位置提示（不含真实值）
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','dismissed')),
    claimed_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
    created_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 审计 / 通知 ----------

-- 只记动作，绝不记内容。detail 仅允许 id / 数量 / 类别等元信息。
CREATE TABLE IF NOT EXISTS audit_logs (
    id          bigserial PRIMARY KEY,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    username    text NOT NULL DEFAULT '',     -- 冗余快照，账号删除后审计链不断
    action      text NOT NULL,
    target_type text NOT NULL DEFAULT '',
    target_id   text NOT NULL DEFAULT '',
    ip          text NOT NULL DEFAULT '',
    reason      text NOT NULL DEFAULT '',     -- 组织恢复等强制理由
    detail      jsonb NOT NULL DEFAULT '{}',
    severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','alert')),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        text NOT NULL,                -- org_recovery / grant / handover ...
    payload     jsonb NOT NULL DEFAULT '{}',  -- 只含 id 与名称等元信息
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

-- ---------- 组（M3）：组只是人的集合，授权展开到个人 ----------
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

-- ---------- 多级目录（文档区=全局共享树；密钥区=每人私有树） ----------
-- owner_id：doc 树为 NULL（全员共享）；secret 树=用户 id（每人独立组织自己的视图）。
-- 删除目录：子目录级联删除；文档/密钥授权行的 folder_id 由外键 SET NULL 自动回到根。
CREATE TABLE IF NOT EXISTS folders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('doc','secret')),
    parent_id   uuid REFERENCES folders(id) ON DELETE CASCADE,
    name        text NOT NULL,
    owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- 同目录下同名唯一（parent/owner 为 NULL 时用零 uuid 参与唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_name ON folders(
    kind,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name,
    COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_folders_kind_owner ON folders(kind, owner_id);

-- 归档列（ADD COLUMN IF NOT EXISTS：对已初始化的库做前向迁移）
ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
ALTER TABLE secret_grants ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
