# 构建参数：前端随镜像构建（api 附带静态资源，不自建 Nginx —— 设计 10.1）
# docker build -t kb-api .
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim AS api
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# 仅装运行时依赖（本地 BGE embedding 在 worker 镜像内，见 Dockerfile.worker）
COPY backend/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

COPY backend/app ./app
COPY backend/scripts ./scripts
# API 只搬密文，不需要 torch/transformers；worker 用独立镜像
COPY --from=web /web/dist ./static

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
