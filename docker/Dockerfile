# ============================================
# 基础构建环境
# ============================================
ARG DOCKER_IMAGE_PREFIX=
FROM ${DOCKER_IMAGE_PREFIX}node:24.10 AS base
ARG NPM_REGISTRY=
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY" && pnpm config set registry "$NPM_REGISTRY"; fi

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run build:base

# ============================================
# 前端构建阶段
# ============================================
FROM base AS frontend-build
ARG VITE_DEFAULT_SERVER=http://127.0.0.1:18010
ARG VITE_FULLSTACK=false
ENV VITE_DEFAULT_SERVER=${VITE_DEFAULT_SERVER}
ENV VITE_FULLSTACK=${VITE_FULLSTACK}
RUN pnpm run --filter biliLive-tools build:webui

# ============================================
# 后端构建阶段
# ============================================
FROM base AS backend-build
RUN pnpm run --filter bililive-cli build && cd packages/CLI && node ./scripts/removeDev.js

ARG GITHUB_PROXY=
ARG GITHUB_PROXY_LIST=
ARG APT_DEBIAN_MIRROR=
ARG APT_SECURITY_MIRROR=

# 下载二进制依赖
ENV GITHUB_PROXY_PREFIX=${GITHUB_PROXY}
ENV GITHUB_PROXY_PREFIXES=${GITHUB_PROXY_LIST}
RUN pnpm run install:bin

RUN cat > /usr/local/bin/github-download <<'EOF' && chmod +x /usr/local/bin/github-download
#!/bin/sh
set -eu
url="$1"
output="$2"
prefixes="${GITHUB_PROXY_PREFIXES:-}"
if [ -z "$prefixes" ] && [ -n "${GITHUB_PROXY_PREFIX:-}" ]; then
  prefixes="$GITHUB_PROXY_PREFIX"
fi
if [ -n "$prefixes" ]; then
  old_ifs="$IFS"
  IFS=','
  for prefix in $prefixes; do
    IFS="$old_ifs"
    [ -z "$prefix" ] && continue
    if curl -fL -o "$output" "${prefix}${url}"; then
      exit 0
    fi
    IFS=','
  done
  IFS="$old_ifs"
fi
curl -fL -o "$output" "$url"
EOF

RUN if [ -n "$APT_DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    if [ -n "$APT_SECURITY_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian-security|$APT_SECURITY_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi

# 下载字体文件
RUN github-download https://github.com/renmu123/biliLive-tools/releases/download/0.2.1/NotoSansSC-Regular.ttf /usr/local/share/fonts/NotoSansSC-Regular.ttf && \
    github-download https://github.com/renmu123/biliLive-tools/releases/download/0.2.1/NotoEmoji-Regular.ttf /usr/local/share/fonts/NotoEmoji-Regular.ttf

# 下载 https://github.com/qjfoidnh/BaiduPCS-Go 二进制文件
RUN mkdir -p /app/baidu-temp /app/packages/app/resources/bin && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        github-download https://github.com/qjfoidnh/BaiduPCS-Go/releases/download/v4.0.1/BaiduPCS-Go-v4.0.1-linux-amd64.zip /app/baidu-temp/BaiduPCS-Go.zip; \
    elif [ "$ARCH" = "aarch64" ]; then \
        github-download https://github.com/qjfoidnh/BaiduPCS-Go/releases/download/v4.0.1/BaiduPCS-Go-v4.0.1-linux-arm64.zip /app/baidu-temp/BaiduPCS-Go.zip; \
    fi && \
    apt-get update && apt-get install -y unzip && \
    unzip /app/baidu-temp/BaiduPCS-Go.zip -d /app/baidu-temp && \
    mv /app/baidu-temp/BaiduPCS-Go-*/BaiduPCS-Go /app/packages/app/resources/bin/BaiduPCS-Go && \
    chmod +x /app/packages/app/resources/bin/BaiduPCS-Go && \
    rm -rf /app/baidu-temp

# 下载 https://github.com/tickstep/aliyunpan 二进制文件
RUN mkdir -p /app/aliyun-temp /app/packages/app/resources/bin && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        github-download https://github.com/tickstep/aliyunpan/releases/download/v0.3.7/aliyunpan-v0.3.7-linux-amd64.zip /app/aliyun-temp/aliyunpan.zip; \
    elif [ "$ARCH" = "aarch64" ]; then \
        github-download https://github.com/tickstep/aliyunpan/releases/download/v0.3.7/aliyunpan-v0.3.7-linux-arm64.zip /app/aliyun-temp/aliyunpan.zip; \
    fi && \
    unzip /app/aliyun-temp/aliyunpan.zip -d /app/aliyun-temp && \
    mv /app/aliyun-temp/aliyunpan-*/aliyunpan /app/packages/app/resources/bin/aliyunpan && \
    chmod +x /app/packages/app/resources/bin/aliyunpan && \
    rm -rf /app/aliyun-temp

# ============================================
# 目标1: 纯前端镜像
# ============================================
FROM caddy:latest AS frontend

WORKDIR /app
RUN mkdir public && mkdir data && mkdir bin

COPY --from=frontend-build /app/packages/app/out/renderer /app/public
COPY --from=base /app/docker/Caddyfile ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["caddy", "run", "--config", "/app/Caddyfile"]

# ============================================
# 目标2: 纯后端镜像
# ============================================
FROM ${DOCKER_IMAGE_PREFIX}node:24.10 AS backend
ARG APT_DEBIAN_MIRROR=
ARG APT_SECURITY_MIRROR=
ARG NPM_REGISTRY=

WORKDIR /app

RUN mkdir data && mkdir bin && mkdir video

COPY --from=backend-build /app/packages/CLI/lib /app
COPY --from=backend-build /app/packages/CLI/package.json /app/package.json
COPY --from=backend-build /app/packages/app/resources/bin /app/bin

RUN if [ -n "$APT_DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    if [ -n "$APT_SECURITY_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian-security|$APT_SECURITY_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends libfontconfig1-dev gosu && \
    apt-get install -y /app/bin/audiowaveform.deb && \
    rm -rf /var/lib/apt/lists/*
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm install --force
COPY --from=backend-build /app/docker/config.json ./
COPY --from=backend-build /usr/local/share/fonts/NotoSansSC-Regular.ttf /usr/share/fonts/NotoSansSC-Regular.ttf
COPY --from=backend-build /usr/local/share/fonts/NotoEmoji-Regular.ttf /usr/share/fonts/NotoEmoji-Regular.ttf
RUN fc-cache -f

COPY --from=base /app/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV IS_DOCKER=true
ENV BAIDUPCS_GO_CONFIG_DIR=/app/data
ENV ALIYUNPAN_CONFIG_DIR=/app/data
ENV TZ=Asia/Shanghai
ENV PUID=0 PGID=0 UMASK=022

EXPOSE 18010

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.cjs", "server", "--config", "config.json"]

# ============================================
# 目标3: 全栈镜像 (默认)
# ============================================
FROM ${DOCKER_IMAGE_PREFIX}node:24.10 AS fullstack
ARG APT_DEBIAN_MIRROR=
ARG APT_SECURITY_MIRROR=
ARG NPM_REGISTRY=
ARG CADDY_GPG_KEY_URL=https://dl.cloudsmith.io/public/caddy/stable/gpg.key
ARG CADDY_DEBIAN_SOURCE_URL=https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt

WORKDIR /app

# 创建必要的目录
RUN mkdir -p /app/data /app/video /app/bin /app/backend /app/public

# 复制后端
COPY --from=backend-build /app/packages/CLI/lib /app/backend
COPY --from=backend-build /app/packages/CLI/package.json /app/backend/package.json
COPY --from=backend-build /app/packages/app/resources/bin /app/bin

# 安装必要的依赖和 Caddy
RUN if [ -n "$APT_DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    if [ -n "$APT_SECURITY_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian-security|$APT_SECURITY_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    libfontconfig1-dev \
    debian-keyring \
    debian-archive-keyring \
    apt-transport-https \
    curl \
    gosu && \
    apt-get install -y /app/bin/audiowaveform.deb && \
    curl -1sLf "$CADDY_GPG_KEY_URL" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
    curl -1sLf "$CADDY_DEBIAN_SOURCE_URL" | tee /etc/apt/sources.list.d/caddy-stable.list && \
    apt-get update && \
    apt-get install -y caddy && \
    rm -rf /var/lib/apt/lists/*
RUN cd /app/backend && if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm install --force
COPY --from=backend-build /usr/local/share/fonts/NotoSansSC-Regular.ttf /usr/share/fonts/NotoSansSC-Regular.ttf
COPY --from=backend-build /usr/local/share/fonts/NotoEmoji-Regular.ttf /usr/share/fonts/NotoEmoji-Regular.ttf
RUN fc-cache -f

# 复制前端 (使用全栈模式构建的前端)
COPY --from=frontend-build /app/packages/app/out/renderer /app/public

# 复制配置文件
COPY --from=base /app/docker/config.json /app/backend/config.json
COPY --from=base /app/docker/fullstack-Caddyfile /etc/caddy/Caddyfile
COPY --from=base /app/docker/start.sh /app/start.sh
COPY --from=base /app/docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /app/start.sh /entrypoint.sh

ENV NODE_ENV=production
ENV IS_DOCKER=true
ENV BAIDUPCS_GO_CONFIG_DIR=/app/data
ENV ALIYUNPAN_CONFIG_DIR=/app/data
ENV TZ=Asia/Shanghai
ENV PUID=0 PGID=0 UMASK=022

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app/start.sh"]
