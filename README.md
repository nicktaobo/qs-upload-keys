# QS Upload Keys

渠道 Key 中转管理平台。前端和 Node.js 后端打包在同一个容器中，PostgreSQL 使用外部服务，不在 Compose 中启动数据库。

## Docker Compose 部署

1. 准备配置：

   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env`，至少填写以下配置：

   - `DATABASE_URL`：外部 PostgreSQL 连接串。数据库必须能从容器网络访问。
   - `DATABASE_SSL`：托管数据库要求 SSL 时设为 `true`。
   - `SESSION_SECRET`：会话签名密钥。
   - `ENCRYPTION_KEY_BASE64`：解码后必须为 32 字节，用于加密保存 Key。
   - `ADMIN_USERNAME`、`ADMIN_PASSWORD`：平台管理员账号。
   - `UPSTREAM_BASE_URL`、`UPSTREAM_USERNAME`、`UPSTREAM_PASSWORD`：上游只读同步配置。
   - `UPSTREAM_WRITE_ENABLED=false`：保持模拟提交，不写入上游。

   可使用以下命令生成密钥：

   ```bash
   openssl rand -hex 32
   openssl rand -base64 32
   ```

3. 启动：

   ```bash
   docker compose pull
   docker compose up -d
   ```

默认访问 `http://服务器地址:3001`。可在 `.env` 中通过 `APP_PORT` 修改宿主机端口。容器内部固定监听 `3000`。

如果 PostgreSQL 运行在 Docker 宿主机上，macOS/Windows 可在连接串中使用 `host.docker.internal`；Linux 建议使用宿主机局域网地址或可路由的数据库域名。

同样地，`UPSTREAM_PROXY_URL` 若指向宿主机代理，容器中不能使用 `127.0.0.1`。macOS/Windows 可改为类似 `http://host.docker.internal:7897` 的地址；Linux 需要使用容器可访问的宿主机地址。

## 直接运行镜像

```bash
docker run -d \
  --name qs-upload-keys \
  --restart unless-stopped \
  --env-file .env \
  -e PORT=3000 \
  -p 3001:3000 \
  ghcr.io/nicktaobo/qs-upload-keys:latest
```

应用启动时会在外部 PostgreSQL 中自动创建所需表。健康检查地址为 `/api/health`。

## 本地构建

```bash
docker build -t qs-upload-keys:local .
docker run --rm --env-file .env -e PORT=3000 -p 3001:3000 qs-upload-keys:local
```

## GHCR 自动构建

GitHub Actions 工作流位于 `.github/workflows/docker.yml`：

- 推送任意分支时构建并发布分支标签与 `sha-*` 标签。
- 默认分支额外发布 `latest`。
- `v*` Git 标签发布同名镜像标签。
- 同时构建 `linux/amd64` 和 `linux/arm64`。
- Pull Request 只构建验证，不推送镜像。

镜像地址：`ghcr.io/nicktaobo/qs-upload-keys`。仓库的 Actions 需要保留默认的 `packages: write` 权限；若镜像为私有包，部署机器需先使用有 `read:packages` 权限的令牌登录 GHCR。
