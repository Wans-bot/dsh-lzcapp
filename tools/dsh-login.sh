#!/usr/bin/env bash
# 在你自己的电脑上运行（不是在盒子里）。
#
# DeepSeek 账号登录的 OAuth 回调只接受 loopback 地址
# （dsh 的 loginOrigin() 硬校验 http://127.0.0.1:<端口>，平台侧 schema 也拒公网地址），
# 所以在公网域名上点「登录」必然失败。这个脚本在本地开一条 SSH 隧道，
# 把 127.0.0.1:3080 转到盒子里的应用容器，浏览器从 loopback 登录就能走通。
#
# 登录一次后凭据写进容器 /data，之后从公网域名访问也是登录态。
#
# 用法： ./dsh-login.sh [root@lzcbox] [本地端口]
set -euo pipefail

BOX="${1:-root@lzcbox}"
LOCAL_PORT="${2:-3080}"
APP_PREFIX="f00700fdeepseek-harness"

info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

info "查询盒子上的应用容器…"
CONTAINER=$(ssh "$BOX" "lzc-docker ps --format '{{.Names}}' | grep '^${APP_PREFIX}' | head -1" 2>/dev/null || true)
if [ -z "${CONTAINER}" ]; then
  warn "没找到运行中的 ${APP_PREFIX}* 容器。先在盒子上确认应用已启动："
  warn "  ssh $BOX 'lzc-docker ps'"
  exit 1
fi

IP=$(ssh "$BOX" "lzc-docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${CONTAINER}")
if [ -z "${IP}" ]; then
  warn "取不到容器 IP。"
  exit 1
fi

info "容器 ${CONTAINER}"
info "隧道 127.0.0.1:${LOCAL_PORT} → ${IP}:3080"
cat <<TIPS

  接下来：
    1. 浏览器打开  http://127.0.0.1:${LOCAL_PORT}/
    2. 点「登录」，在跳转的页面里完成 DeepSeek 账号授权
    3. 回到 http://127.0.0.1:${LOCAL_PORT}/ 看到已登录即可
    4. 按 Ctrl-C 关掉隧道

  登录态保存在容器 /data 里，之后用公网域名访问同样是已登录。

TIPS

exec ssh -N -L "${LOCAL_PORT}:${IP}:3080" "$BOX"
