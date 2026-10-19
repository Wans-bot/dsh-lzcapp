#!/bin/bash
# DeepSeek Harness 指纹验收（lzcos 应用容器要用 lzc-docker 才看得到）
# 用法: dsh-verify.sh [期望的 dsh 版本]
set -uo pipefail

WANT="${1:-0.2.1-rc.2}"
PKG=f00700f.deepseek-harness
APP_CONTAINER="f00700fdeepseek-harness-dsh-1"
pass=0
fail=0

ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }
check(){ if [ "$1" = "$2" ]; then ok "$3（$1）"; else bad "$3（期望 $2，实际 $1）"; fi; }

echo "== 1. 包已登记 =="
if lpk-manager list 2>/dev/null | grep -qx "  - $PKG"; then ok "$PKG 已安装"; else bad "未安装 $PKG"; fi

echo "== 2. 容器在跑 =="
status=$(lzc-docker ps --filter "name=$APP_CONTAINER" --format '{{.Status}}' 2>/dev/null)
case "$status" in
  Up*) ok "容器 $APP_CONTAINER：$status" ;;
  *)   bad "容器未运行（status=${status:-无}）" ;;
esac

echo "== 3. 镜像来自懒猫官方源 =="
img=$(lzc-docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER" 2>/dev/null)
case "$img" in
  registry.lazycat.cloud/*) ok "image=$img" ;;
  *) bad "image=${img:-未知}，不是 registry.lazycat.cloud" ;;
esac

echo "== 4. 容器内 dsh 版本 =="
got=$(lzc-docker exec "$APP_CONTAINER" sh -c 'dsh --version' 2>/dev/null | tr -d '\r')
check "$got" "$WANT" "dsh --version"

echo "== 5. 插件市场随包 =="
mk=$(lzc-docker exec "$APP_CONTAINER" node -e 'try{process.stdout.write(require("/data/profiles/web/node_modules/dshmarket/package.json").version)}catch(e){process.stdout.write("0.0.0")}' 2>/dev/null)
if [ "$mk" != "0.0.0" ] && [ -n "$mk" ]; then ok "dshmarket $mk 已随包"; else bad "dshmarket 缺失"; fi

echo "== 6. 免登录代理（首访 303 → 带 cookie 200）=="
proxy=$(lzc-docker exec "$APP_CONTAINER" node -e '
const http=require("http");
function req(h){return new Promise(r=>{const q=http.get({host:"127.0.0.1",port:3080,path:"/",headers:h},res=>{
  let n=0;res.on("data",d=>n+=d.length);res.on("end",()=>r({code:res.statusCode,size:n,cookie:(res.headers["set-cookie"]||[]).join(";")}))
});q.on("error",e=>r({code:-1,size:0,err:e.message}))})}
(async()=>{const a=await req({});const c=(a.cookie.match(/[^;]+/)||[""])[0];const b=await req({Cookie:c});
 process.stdout.write(`${a.code} ${b.code} ${b.size}`)})()' 2>/dev/null)
set -- $proxy
if [ "${1:-0}" = "303" ] && [ "${2:-0}" = "200" ] && [ "${3:-0}" -gt 1000 ] 2>/dev/null; then
  ok "首访 303 → 带 cookie 200（${3} 字节 HTML）"
else
  bad "代理异常（首访=${1:-?} 二次=${2:-?} 大小=${3:-?}）"
fi

echo "== 7. Settings 持久化补丁 =="
n=$(lzc-docker exec "$APP_CONTAINER" sh -c 'grep -c "isLoopback" /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js 2>/dev/null || echo 0' 2>/dev/null | tr -d '\r')
if [ "${n:-0}" -ge 1 ] 2>/dev/null; then ok "补丁已落地（isLoopback 命中 $n 处）"; else bad "补丁未生效"; fi

echo
echo "== 结果: 通过 $pass 项，失败 $fail 项 =="
[ "$fail" -eq 0 ] && echo "验收通过 ✔" || echo "验收未通过 ✘"
exit "$fail"
