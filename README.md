# 私有知识库与密钥管理系统

一个地方，把「公司写过的文档」和「记不住的凭据」分开管：文档交给 AI 读懂、搜得到、问得出答案；凭据用前端加密存起来，服务端连管理员都解不开——但管理员凭自己的主密码能代为恢复。

依据《开发文档与密钥管理系统-设计方案v1.1-内部版》实现（M1 文档知识库 / M2 密钥模块 / M3 内部上线）。

## 仓库结构

```bash
backend/    FastAPI API + 索引 worker（Python）
frontend/   React + TS + Vite（全部浏览器端加密）
docs/       DDL / 加密流程 / 任务拆解 / 部署运维 / 内部规范 / 上线清单
scripts → backend/scripts   备份 / 恢复 / 离线解密
backend/docker-compose.yml  api + worker + postgres(pgvector) + redis
```

## 快速开始（服务器）

```bash
cp .env.example .env          # 填 POSTGRES_PASSWORD / LLM_API_* 等
docker compose -f backend/docker-compose.yml up -d --build
# 打开 http://<host>:8000  → 首次访问进入"系统引导"
```bash

首次引导会一次性展示 **个人恢复码** 与 **组织离线恢复码**，并自动下载**离线恢复包**——立即抄写、打印、入柜。

## 本地开发

```bash
# 基础设施
docker run -d --name kb-pg -p 5432:5432 -e POSTGRES_USER=kb -e POSTGRES_PASSWORD=kb \
  -e POSTGRES_DB=kb pgvector/pgvector:pg16
docker run -d --name kb-redis -p 6379:6379 redis:7-alpine

# 后端
cd backend
pip install -r requirements.txt
set COOKIE_SECURE=false            # 本地 http 需要（Windows: set / $env:）
uvicorn app.main:app --reload --port 8000     # 终端 1
python -m app.worker                          # 终端 2（首次会下载 bge 模型）

# 前端
cd frontend
npm install
npm run dev                        # http://localhost:5173（已代理到 8000）
```

本地开发注意：`COOKIE_SECURE=false`，否则 http 下会话 Cookie 不生效。

## 测试

```bash
cd backend && python -m pytest tests/ -q        # 脱敏闸 / 分块 / 加密镜像 / TS↔PY 互操作
cd frontend && npm test                          # 同一套规则的 TS 侧验证 + 生成互操作向量
```bash

互操作向量流程：先跑 `frontend npm test`（生成 `frontend/tests/vectors.json`），再跑 `backend pytest`（末位用例 `test_typescript_interop` 用 Python 解开 TS 密封的密文）。

## 安全模型速览

- 主密码只在浏览器里做 Argon2id 派生；服务端只持有登录证明密钥（HKDF 后），无法反推数据密钥。
- 每条密钥一个随机 DEK；内容 AES-256-GCM（AAD 绑定条目 id）；DEK 分别用「每个有权访问者的 X25519 公钥」与「组织恢复公钥」包装。
- 管理员代为恢复：每次强制理由 + 审计 + 通知所有者；离线破窗走「离线恢复码 + 恢复包 + offline_recover.py」。
- 文档入库前在浏览器里做凭据预扫（前缀 / 连接串 / 键值对 / 高熵），确认替换为 `{{secret:slug}}` 才上传；服务端再做一次兜底扫描。
- AI 问答的输出会再过一次同一套规则，命中即整段阻断并写高优先级审计。

详见 `docs/03-加密流程伪代码.md` 与 `docs/07-上线检查清单.md`。

## 日常运维

```bash
# 每日备份（crontab）：
DATABASE_URL=postgresql://... BACKUP_DIR=/var/backups/kb \
  backend/scripts/backup.sh
# 每月恢复演练：
backend/scripts/restore.sh <备份.enc> postgresql://...kb_restore
# 离线恢复演练（隔离环境）：
python backend/scripts/offline_recover.py --package org-recovery-package.json \
  --code <离线恢复码> --database postgresql://...
```

## 员工须知

见 `docs/06-内部使用规范.md`（上线时发给全体使用人）。
