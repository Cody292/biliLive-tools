# ============================================
# 基础构建环境
# ============================================
ARG DOCKER_IMAGE_PREFIX=
ARG CADDY_IMAGE=docker.m.daocloud.io/library/caddy:2
FROM ${DOCKER_IMAGE_PREFIX}node:24.18 AS base
ARG NPM_REGISTRY=
ARG NPM_FALLBACK_REGISTRY=https://registry.npmjs.org/
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN cat > /usr/local/bin/configure-npm-registry <<'EOF' && chmod +x /usr/local/bin/configure-npm-registry
#!/bin/sh
set -eu
primary="${NPM_REGISTRY:-}"
fallback="${NPM_FALLBACK_REGISTRY:-https://registry.npmjs.org/}"
registry="$fallback"
if [ -n "$primary" ]; then
  if timeout 8s node - "$primary" <<'NODE' >/dev/null 2>&1
const registry = process.argv[2].replace(/\/+$/, "");
const response = await fetch(`${registry}/pnpm/11.5.0`, {
  signal: AbortSignal.timeout(5000),
  headers: { accept: "application/json" },
});
if (!response.ok) {
  process.exit(1);
}
NODE
  then
    registry="$primary"
  else
    echo "primary npm registry unavailable, fallback to $fallback" >&2
  fi
fi
npm config set registry "$registry"
if command -v pnpm >/dev/null 2>&1; then
  pnpm config set registry "$registry"
fi
printf '%s\n' "$registry"
EOF
RUN set -eux; \
    corepack enable; \
    registry="$(configure-npm-registry)"; \
    export COREPACK_NPM_REGISTRY="$registry"; \
    corepack prepare pnpm@11.5.0 --activate; \
    configure-npm-registry >/dev/null

WORKDIR /app
# 依赖清单层与源码层分离：仅 package 清单变更时重跑 pnpm install（#12 主要耗时）
# pnpm store 使用 BuildKit cache 跨构建复用
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY packages/app/package.json ./packages/app/
COPY packages/BilibiliRecorder/package.json ./packages/BilibiliRecorder/
COPY packages/CLI/package.json ./packages/CLI/
COPY packages/DouYinDanma/package.json ./packages/DouYinDanma/
COPY packages/DouYinRecorder/package.json ./packages/DouYinRecorder/
COPY packages/DouYuRecorder/package.json ./packages/DouYuRecorder/
COPY packages/http/package.json ./packages/http/
COPY packages/huya-danmu/package.json ./packages/huya-danmu/
COPY packages/HuYaRecorder/package.json ./packages/HuYaRecorder/
COPY packages/liveManager/package.json ./packages/liveManager/
COPY packages/shared/package.json ./packages/shared/
COPY packages/StreamGet/package.json ./packages/StreamGet/
COPY packages/types/package.json ./packages/types/
COPY packages/XHSRecorder/package.json ./packages/XHSRecorder/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    configure-npm-registry >/dev/null && \
    pnpm install --frozen-lockfile --ignore-scripts
# 仅复制 docker 运行配置（final 阶段 --from=base 需要）；业务源码不进 base，避免 COPY 抖动击穿 install 缓存语义之外的共享层
COPY docker ./docker

# ============================================
# 源码 + 公共基础包构建（不作为 runtime/system deps 父级）
# ============================================
FROM base AS source-build-base
# 源码层：业务代码变动只使本层及后续 build 失效，不重下依赖
COPY . .
RUN pnpm run build:base

# ============================================
# 前端构建阶段
# ============================================
FROM source-build-base AS frontend-build
ARG VITE_DEFAULT_SERVER=http://127.0.0.1:18010
ARG VITE_FULLSTACK=false
ENV VITE_DEFAULT_SERVER=${VITE_DEFAULT_SERVER}
ENV VITE_FULLSTACK=${VITE_FULLSTACK}
RUN pnpm run --filter biliLive-tools build:webui

# ============================================
# 后端构建阶段
# ============================================
FROM source-build-base AS backend-build
RUN pnpm run --filter bililive-cli build && cd packages/CLI && node ./scripts/removeDev.js
# 生成生产 runtime（lib + package.json + prod node_modules），复用 pnpm store cache，避免二次 npm install
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    configure-npm-registry >/dev/null && \
    pnpm --filter bililive-cli --prod --legacy deploy /app/backend-runtime \
    && mkdir -p /app/backend-runtime/node_modules/@napi-rs \
    && (cp -r /app/node_modules/.pnpm/@napi-rs+canvas-linux-x64-gnu*/node_modules/@napi-rs/canvas-linux-x64-gnu /app/backend-runtime/node_modules/@napi-rs/ 2>/dev/null || cp -r /app/node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas-linux-x64-gnu /app/backend-runtime/node_modules/@napi-rs/ 2>/dev/null || true) \
    && test -f /app/backend-runtime/package.json \
    && test -d /app/backend-runtime/lib \
    && test -d /app/backend-runtime/node_modules

ARG GITHUB_PROXY=
ARG GITHUB_PROXY_LIST=
ARG APT_DEBIAN_MIRROR=
ARG APT_SECURITY_MIRROR=

# 下载二进制依赖（BuildKit cache 跨构建复用）
# 注意：不要用 `pnpm run install:bin`——pnpm 可能先 runDepsStatusCheck 再触发 install/git fetch
ENV GITHUB_PROXY_PREFIX=${GITHUB_PROXY}
ENV GITHUB_PROXY_PREFIXES=${GITHUB_PROXY_LIST}
RUN --mount=type=cache,id=bili-downloads,target=/app/.download-cache \
    BILILIVE_TOOLS_DOWNLOAD_CACHE_DIR=/app/.download-cache \
    node ./scripts/install-bin.js


# 带缓存的 github 下载器：优先命中 /app/.download-cache
RUN cat > /usr/local/bin/github-download <<'EOF' && chmod +x /usr/local/bin/github-download
#!/bin/sh
set -eu
url="$1"
output="$2"
cache_dir="${BILILIVE_TOOLS_DOWNLOAD_CACHE_DIR:-/app/.download-cache}"
mkdir -p "$cache_dir" "$(dirname "$output")"
name="$(basename "$output")"
# 同 basename 可能冲突，用 URL 路径哈希后缀
safe="$(printf '%s' "$url" | tr '/:@?&=' '_' | tail -c 80)"
cache_file="$cache_dir/${safe}_${name}"
if [ -f "$cache_file" ] && [ -s "$cache_file" ]; then
  cp -f "$cache_file" "$output"
  echo "cache hit: $name"
  exit 0
fi
prefixes="${GITHUB_PROXY_PREFIXES:-}"
if [ -z "$prefixes" ] && [ -n "${GITHUB_PROXY_PREFIX:-}" ]; then
  prefixes="$GITHUB_PROXY_PREFIX"
fi
tmp="$cache_file.part"
rm -f "$tmp"
if [ -n "$prefixes" ]; then
  old_ifs="$IFS"
  IFS=','
  for prefix in $prefixes; do
    IFS="$old_ifs"
    [ -z "$prefix" ] && continue
    if curl -fL --retry 3 --retry-delay 2 -o "$tmp" "${prefix}${url}"; then
      mv -f "$tmp" "$cache_file"
      cp -f "$cache_file" "$output"
      exit 0
    fi
    rm -f "$tmp"
    IFS=','
  done
  IFS="$old_ifs"
fi
curl -fL --retry 3 --retry-delay 2 -o "$tmp" "$url"
mv -f "$tmp" "$cache_file"
cp -f "$cache_file" "$output"
EOF

RUN if [ -n "$APT_DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    if [ -n "$APT_SECURITY_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian-security|$APT_SECURITY_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi

# 字体：优先本地 docker/fonts；网盘 CLI：github-download + BuildKit cache
# 独立下载任务在同一 RUN 内并行执行；任一下载失败则整体失败（不隐藏错误）
RUN --mount=type=cache,id=bili-downloads,target=/app/.download-cache \
    --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists,sharing=locked \
    set -eu; \
    export BILILIVE_TOOLS_DOWNLOAD_CACHE_DIR=/app/.download-cache; \
    mkdir -p /usr/local/share/fonts /app/baidu-temp /app/aliyun-temp /app/packages/app/resources/bin /tmp/dl-fail; \
    ARCH=$(uname -m); \
    download_job() { \
      label="$1"; shift; \
      if "$@"; then \
        echo "download_ok: $label"; \
      else \
        echo "download_fail: $label" >&2; \
        echo "$label" > "/tmp/dl-fail/$label"; \
        return 1; \
      fi; \
    }; \
    pids=""; \
    if [ -f /app/docker/fonts/NotoSansSC-Regular.ttf ]; then \
      cp /app/docker/fonts/NotoSansSC-Regular.ttf /usr/local/share/fonts/NotoSansSC-Regular.ttf; \
      echo "font local: NotoSansSC"; \
    else \
      download_job font_sc github-download \
        https://github.com/renmu123/biliLive-tools/releases/download/0.2.1/NotoSansSC-Regular.ttf \
        /usr/local/share/fonts/NotoSansSC-Regular.ttf & pids="$pids $!"; \
    fi; \
    if [ -f /app/docker/fonts/NotoEmoji-Regular.ttf ]; then \
      cp /app/docker/fonts/NotoEmoji-Regular.ttf /usr/local/share/fonts/NotoEmoji-Regular.ttf; \
      echo "font local: NotoEmoji"; \
    else \
      download_job font_emoji github-download \
        https://github.com/renmu123/biliLive-tools/releases/download/0.2.1/NotoEmoji-Regular.ttf \
        /usr/local/share/fonts/NotoEmoji-Regular.ttf & pids="$pids $!"; \
    fi; \
    if [ -x /app/packages/app/resources/bin/BaiduPCS-Go ]; then \
      echo "reuse BaiduPCS-Go"; \
    elif [ "$ARCH" = "x86_64" ]; then \
      download_job baidu github-download \
        https://github.com/qjfoidnh/BaiduPCS-Go/releases/download/v4.0.1/BaiduPCS-Go-v4.0.1-linux-amd64.zip \
        /app/baidu-temp/BaiduPCS-Go.zip & pids="$pids $!"; \
    elif [ "$ARCH" = "aarch64" ]; then \
      download_job baidu github-download \
        https://github.com/qjfoidnh/BaiduPCS-Go/releases/download/v4.0.1/BaiduPCS-Go-v4.0.1-linux-arm64.zip \
        /app/baidu-temp/BaiduPCS-Go.zip & pids="$pids $!"; \
    fi; \
    if [ -x /app/packages/app/resources/bin/aliyunpan ]; then \
      echo "reuse aliyunpan"; \
    elif [ "$ARCH" = "x86_64" ]; then \
      download_job aliyun github-download \
        https://github.com/tickstep/aliyunpan/releases/download/v0.3.7/aliyunpan-v0.3.7-linux-amd64.zip \
        /app/aliyun-temp/aliyunpan.zip & pids="$pids $!"; \
    elif [ "$ARCH" = "aarch64" ]; then \
      download_job aliyun github-download \
        https://github.com/tickstep/aliyunpan/releases/download/v0.3.7/aliyunpan-v0.3.7-linux-arm64.zip \
        /app/aliyun-temp/aliyunpan.zip & pids="$pids $!"; \
    fi; \
    fail=0; \
    for pid in $pids; do \
      if ! wait "$pid"; then fail=1; fi; \
    done; \
    if [ "$fail" -ne 0 ] || [ -n "$(ls -A /tmp/dl-fail 2>/dev/null || true)" ]; then \
      echo "ERROR: one or more parallel downloads failed: $(ls /tmp/dl-fail 2>/dev/null | tr '\n' ' ')" >&2; \
      exit 1; \
    fi; \
    rm -f /var/cache/apt/archives/lock /var/lib/apt/lists/lock /var/cache/apt/archives/partial/* 2>/dev/null || true; \
    if [ -f /app/baidu-temp/BaiduPCS-Go.zip ] || [ -f /app/aliyun-temp/aliyunpan.zip ]; then \
      apt-get update && apt-get install -y --no-install-recommends unzip; \
    fi; \
    if [ -f /app/baidu-temp/BaiduPCS-Go.zip ]; then \
      unzip /app/baidu-temp/BaiduPCS-Go.zip -d /app/baidu-temp && \
      mv /app/baidu-temp/BaiduPCS-Go-*/BaiduPCS-Go /app/packages/app/resources/bin/BaiduPCS-Go && \
      chmod +x /app/packages/app/resources/bin/BaiduPCS-Go; \
    fi; \
    if [ -f /app/aliyun-temp/aliyunpan.zip ]; then \
      unzip /app/aliyun-temp/aliyunpan.zip -d /app/aliyun-temp && \
      mv /app/aliyun-temp/aliyunpan-*/aliyunpan /app/packages/app/resources/bin/aliyunpan && \
      chmod +x /app/packages/app/resources/bin/aliyunpan; \
    fi; \
    rm -rf /app/baidu-temp /app/aliyun-temp /tmp/dl-fail


# Caddy 二进制：默认 DaoCloud（可用 --build-arg CADDY_IMAGE= 覆盖）
FROM ${CADDY_IMAGE} AS caddy-bin

# ============================================
# 目标1: 纯前端镜像
# ============================================
FROM ${CADDY_IMAGE} AS frontend

WORKDIR /app
RUN mkdir public && mkdir data && mkdir bin

COPY --from=frontend-build /app/packages/app/out/renderer /app/public
COPY --from=base /app/docker/Caddyfile ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["caddy", "run", "--config", "/app/Caddyfile"]

# ============================================
# 稳定 runtime 系统依赖（不依赖源码/产物 COPY，可缓存）
# ============================================
FROM ${DOCKER_IMAGE_PREFIX}node:24.18 AS backend-runtime-deps
ARG APT_DEBIAN_MIRROR=
ARG APT_SECURITY_MIRROR=
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists,sharing=locked \
    if [ -n "$APT_DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    if [ -n "$APT_SECURITY_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian-security|$APT_SECURITY_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    rm -f /var/cache/apt/archives/lock /var/lib/apt/lists/lock 2>/dev/null || true && \
    apt-get update && \
    apt-get install -y --no-install-recommends libfontconfig1-dev gosu

FROM ${DOCKER_IMAGE_PREFIX}node:24.18 AS fullstack-runtime-deps
ARG APT_DEBIAN_MIRROR=
ARG APT_SECURITY_MIRROR=
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists,sharing=locked \
    if [ -n "$APT_DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    if [ -n "$APT_SECURITY_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian-security|$APT_SECURITY_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi && \
    rm -f /var/cache/apt/archives/lock /var/lib/apt/lists/lock 2>/dev/null || true && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    libfontconfig1-dev \
    debian-keyring \
    debian-archive-keyring \
    apt-transport-https \
    curl \
    gosu \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils

# ============================================
# Playwright Chromium 下载（与 backend-build / frontend-build 并行；无需 COPY backend-runtime；固定 playwright-core@1.61.1）
# 上轮耗时瓶颈为串行化及 apt/pnpm/playwright/github 网络传输，而非缺少 1ms 前缀
# ============================================
FROM fullstack-runtime-deps AS browser-download
ARG NPM_REGISTRY=
ARG NPM_FALLBACK_REGISTRY=https://registry.npmjs.org/
# Playwright 浏览器下载镜像：不写死默认 host，由 --build-arg 传入
# 推荐（国内）：--build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
# 留空则走 Playwright 官方 CDN（可能较慢/被墙）
ARG PLAYWRIGHT_DOWNLOAD_HOST
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=
COPY --from=base /usr/local/bin/configure-npm-registry /usr/local/bin/configure-npm-registry

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
RUN --mount=type=cache,id=ms-playwright,target=/root/.cache/ms-playwright \
    if [ -n "$HTTP_PROXY" ]; then export HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"; fi && \
    if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi && \
    mkdir -p /ms-playwright && \
    configure-npm-registry >/dev/null && \
    npx --yes playwright-core@1.61.1 install chromium && \
    if [ -d /root/.cache/ms-playwright ]; then cp -a /root/.cache/ms-playwright/. /ms-playwright/; fi && \
    rm -rf /ms-playwright/chromium_headless_shell-* /ms-playwright/ffmpeg-* 2>/dev/null || true && \
    CHROME_BIN="$(find /ms-playwright -type f \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) 2>/dev/null | head -n1)" && \
    if [ -n "$CHROME_BIN" ]; then ln -sfn "$CHROME_BIN" /usr/local/bin/douyin-chrome && echo "chromium=$CHROME_BIN"; else echo "WARN: chromium not found"; fi

# ============================================
# 目标2: 纯后端镜像
# ============================================
FROM backend-runtime-deps AS backend
ARG NPM_REGISTRY=
ARG NPM_FALLBACK_REGISTRY=https://registry.npmjs.org/
COPY --from=base /usr/local/bin/configure-npm-registry /usr/local/bin/configure-npm-registry

WORKDIR /app

RUN mkdir data && mkdir bin && mkdir video

COPY --from=backend-build /app/backend-runtime/lib /app
COPY --from=backend-build /app/backend-runtime/package.json /app/package.json
COPY --from=backend-build /app/backend-runtime/node_modules /app/node_modules
COPY --from=backend-build /app/packages/app/resources/bin /app/bin
RUN rm -f /app/bin/obscura /app/bin/obscura-worker \
    && rm -f /app/bin/obscura-*.tar.gz /app/bin/*.pdb /app/bin/*.xml \
    && rm -f "/app/bin/DanmakuFactory CLI 参数说明.md" 2>/dev/null || true

# 本地 deb 来自 backend-build 产物，仅在 final 单独安装（失败可见）
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /var/cache/apt/archives/lock /var/lib/apt/lists/lock 2>/dev/null || true && \
    apt-get install -y /app/bin/audiowaveform.deb
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
# 目标3: 全栈镜像 (默认) — 仅装配，不执行浏览器下载
# ============================================
FROM fullstack-runtime-deps AS fullstack
ARG NPM_REGISTRY=
ARG NPM_FALLBACK_REGISTRY=https://registry.npmjs.org/
COPY --from=base /usr/local/bin/configure-npm-registry /usr/local/bin/configure-npm-registry

WORKDIR /app

# 创建必要的目录
RUN mkdir -p /app/data /app/video /app/bin /app/backend /app/public

# 复制后端
COPY --from=backend-build /app/backend-runtime/lib /app/backend
COPY --from=backend-build /app/backend-runtime/package.json /app/backend/package.json
COPY --from=backend-build /app/backend-runtime/node_modules /app/backend/node_modules
COPY --from=backend-build /app/packages/app/resources/bin /app/bin
RUN rm -f /app/bin/obscura /app/bin/obscura-worker \
    && rm -f /app/bin/obscura-*.tar.gz /app/bin/*.pdb /app/bin/*.xml \
    && rm -f "/app/bin/DanmakuFactory CLI 参数说明.md" 2>/dev/null || true

# 从 Caddy 官方镜像复制二进制（默认 DaoCloud，不走 cloudsmith apt）
COPY --from=caddy-bin /usr/bin/caddy /usr/bin/caddy

# 本地 deb 来自 backend-build 产物；caddy 校验在二进制 COPY 后执行
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /var/cache/apt/archives/lock /var/lib/apt/lists/lock 2>/dev/null || true && \
    apt-get install -y /app/bin/audiowaveform.deb && \
    caddy version

# 浏览器产物：由 browser-download stage 预生成，final 仅 COPY（可与 frontend 并行）
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=browser-download /ms-playwright /ms-playwright
RUN CHROME_BIN="$(find /ms-playwright -type f \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) 2>/dev/null | head -n1)" && \
    test -n "$CHROME_BIN" && \
    ln -sfn "$CHROME_BIN" /usr/local/bin/douyin-chrome && \
    echo "chromium=$CHROME_BIN"
ENV DOUYIN_CHROME_PATH=/usr/local/bin/douyin-chrome

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
