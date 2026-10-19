#!/bin/bash
# 从 GitHub Release 拉取 DSH LPK 装到本机并做指纹验收。
# 用法: dsh-sync.sh [tag] [期望 dsh 版本]
#   dsh-sync.sh                  # 取最新 release
#   dsh-sync.sh v1.1.6 0.2.1-rc.2
set -euo pipefail

REPO="Wans-bot/dsh-lzcapp"
TAG="${1:-latest}"
DSH_WANT="${2:-0.2.1-rc.2}"
GH_PROXY="${GH_PROXY:-https://gh-proxy.com}"
WORK=/root/dsh-sync
mkdir -p "$WORK"

if [ "$TAG" = "latest" ]; then
  TAG=$(curl -fsSL --max-time 30 "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v[^"]*\)"/\1/')
fi
[ -n "$TAG" ] || { echo "无法解析 release tag"; exit 1; }
echo "=== 目标 release: $TAG ==="

PKG="f00700f.deepseek-harness-$TAG.lpk"
URL="$GH_PROXY/https://github.com/$REPO/releases/download/$TAG/$PKG"
OUT="$WORK/$PKG"
echo "=== 下载: $URL"
rm -f "$OUT"
curl -fsSL --retry 4 --retry-delay 3 --max-time 600 -o "$OUT" "$URL"
ls -la "$OUT"
echo "=== sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"

echo "=== 安装 ==="
lpk-manager install "$OUT" 2>&1 | tail -5

# 注意：lzcos 的应用容器对宿主机普通 docker 不可见，必须用 lzc-docker。
echo "=== 等待容器起好（最多 300s）==="
C=f00700fdeepseek-harness-dsh-1
running=0
for i in $(seq 1 60); do
  if lzc-docker ps --filter "name=$C" --format '{{.Status}}' 2>/dev/null | grep -q '^Up'; then
    running=1
    echo "容器已启动: $(lzc-docker ps --filter "name=$C" --format '{{.Names}} {{.Status}}')"
    break
  fi
  sleep 5
done
[ "$running" -eq 1 ] || { echo "!! 容器没起来"; lzc-docker ps -a --filter "name=$C" --format '{{.Names}} {{.Status}}'; exit 1; }

echo "=== 指纹验收 (期望 dsh $DSH_WANT) ==="
bash /root/dsh-verify.sh "$DSH_WANT"
