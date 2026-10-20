#!/bin/sh
# LazyCat DSH entrypoint.
#
#   1. provide the Documents directory dsh asks for on first use
#   2. reconcile the bundled plugin market with the running dsh release
#      (keeps /data/profiles usable across app upgrades)
#   3. patch the Settings persistence selector for the box-assigned app domain
#   4. start "dsh web" on loopback and expose it through the auth auto-proxy
set -eu

DSH_HOME_DIR="${DSH_HOME:-/data}"
TPL=/opt/dsh-profile-template/profiles
WEBPROF="$DSH_HOME_DIR/profiles/web"
MARKET_DIR="$WEBPROF/node_modules/dshmarket"
LEGACY_DOCS="$DSH_HOME_DIR/documents"
APP_DOCUMENTS_ROOT=/lzcapp/documents
DOCUMENT_ROOT=/lzcapp/document
APP_PACKAGE="${LAZYCAT_APP_ID:-f00700f.deepseek-harness}"
DOCS_DIR="${DSH_DOCUMENTS_DIR:-}"

# --- 1. Documents directory -> 网盘「应用文稿」 --------------------------------
# 审核单 #20857 驳回原文：「更新后工作区文件丢失，需要对工作区文件进行持久化储存，
# 储存到网盘应用文稿内」。dsh 把首个工作区建在 <Documents>/deepseek-harness/
# default-workspace，所以 Documents 指向哪里，工作区就落在哪里。
#
# 有了 document.private，平台会挂两块网盘存储进来（都不需要自己 bind）：
#   /lzcapp/documents/<用户>               本应用的「应用文稿」，就是文件管理器里
#                                          那个应用文稿目录（指向 …/.apps/<包ID>）
#   /lzcapp/document/<用户>/               整个网盘主目录（桌面/下载/图片…），
#                                          应用文稿在其中的 .apps/<包ID>/ 下
# 应用文稿带备份、跟着还原走、卸载默认不删，正是审核要求的持久化位置（盒子上的
# sqmusic / photo / lzcwrt 等应用也都把数据写在这里）。相比之下 /root、/tmp 和
# 镜像层每次更新都会重建；/data（= /lzcapp/var）只是应用私有卷。两块都没挂
# （用户没授权 document.private）时回退到私有卷，绝不让容器起不来。
if [ -z "$DOCS_DIR" ]; then
  for app_home in "$APP_DOCUMENTS_ROOT"/*; do
    [ -d "$app_home" ] || continue
    DOCS_DIR="$app_home"
    break
  done
fi
if [ -z "$DOCS_DIR" ]; then
  for user_home in "$DOCUMENT_ROOT"/*; do
    [ -d "$user_home/.apps" ] || continue
    DOCS_DIR="$user_home/.apps/$APP_PACKAGE"
    break
  done
fi
if [ -n "$DOCS_DIR" ] && mkdir -p "$DOCS_DIR" 2>/dev/null && [ -w "$DOCS_DIR" ]; then
  :
else
  if [ -n "$DOCS_DIR" ]; then
    echo "WARN: cannot use app documents at $DOCS_DIR" >&2
  fi
  echo "WARN: netdisk app documents not mounted; workspace stays on $LEGACY_DOCS" >&2
  DOCS_DIR="$LEGACY_DOCS"
  mkdir -p "$DOCS_DIR"
fi

# dsh 把工作区位置以绝对路径存进设置，<=1.1.12 存的是 $LEGACY_DOCS/...；把旧路径
# 变成指向应用文稿的软链，升级上来的用户原来那个工作区照样能打开，文件也就跟着进了
# 网盘。首次迁移先把老目录内容拷进去（拷贝失败就保留原目录、不强上软链）。
if [ "$DOCS_DIR" != "$LEGACY_DOCS" ]; then
  if [ -d "$LEGACY_DOCS" ] && [ ! -L "$LEGACY_DOCS" ]; then
    echo "migrating $LEGACY_DOCS -> $DOCS_DIR"
    if cp -a "$LEGACY_DOCS/." "$DOCS_DIR/" 2>/dev/null; then
      rm -rf "$LEGACY_DOCS"
    else
      echo "WARN: migration copy failed; keeping $LEGACY_DOCS as-is" >&2
    fi
  fi
  [ -e "$LEGACY_DOCS" ] || ln -sfn "$DOCS_DIR" "$LEGACY_DOCS"
fi
echo "workspace documents: $DOCS_DIR"

# dsh 0.2 resolves <Documents>/deepseek-harness/default-workspace through
# `xdg-user-dir DOCUMENTS`; the Debian base image has no xdg-user-dirs, so the
# first page load reports "Unable to create default workspace" and the empty
# state never seeds. Answer with the app-documents path above, and never shadow
# a real xdg-user-dir.
mkdir -p /usr/local/bin
EXISTING_XDG=$(command -v xdg-user-dir || true)
if [ -z "$EXISTING_XDG" ] || [ "$EXISTING_XDG" = /usr/local/bin/xdg-user-dir ]; then
  cat > /usr/local/bin/xdg-user-dir <<SHIM
#!/bin/sh
# Minimal xdg-user-dir for this image: DSH asks for DOCUMENTS on first use.
case "\${1:-}" in
  DOCUMENTS) printf '%s\n' "$DOCS_DIR" ;;
  *)         printf '%s\n' "\${HOME:-/root}" ;;
esac
SHIM
  chmod 0755 /usr/local/bin/xdg-user-dir
  echo "installed xdg-user-dir shim (DOCUMENTS=$DOCS_DIR)"
else
  echo "keeping system xdg-user-dir at $EXISTING_XDG"
fi

# --- 2. plugin market reconciliation ---------------------------------------
# Fresh install: seed the whole profile from the image template.
if [ -d "$TPL" ] && [ ! -d "$MARKET_DIR" ]; then
  echo "seeding bundled plugin market into $DSH_HOME_DIR/profiles"
  mkdir -p "$DSH_HOME_DIR/profiles"
  cp -a "$TPL/." "$DSH_HOME_DIR/profiles/" 2>/dev/null || true
fi

# Existing install: the market version carried in /data may be too old for the
# dsh release in this image (peer range mismatch => dsh skips the bundle and the
# Plugin Market page disappears). Re-vendor only the market subtree from the
# image when the shipped one is strictly newer; never touch the rest of /data.
if [ -f "$MARKET_DIR/package.json" ] && [ -d "$TPL/web/node_modules/dshmarket" ]; then
  HAVE=$(node -e "try{process.stdout.write(require('$MARKET_DIR/package.json').version)}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null || echo 0.0.0)
  WANT=$(node -e "try{process.stdout.write(require('$TPL/web/node_modules/dshmarket/package.json').version)}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null || echo 0.0.0)
  if [ "$HAVE" != "$WANT" ]; then
    NEWER=$(node -e "
      const semver=require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/semver');
      try{process.stdout.write(semver.gt('$WANT','$HAVE')?'yes':'no')}catch(e){process.stdout.write('no')}
    " 2>/dev/null || echo no)
    if [ "$NEWER" = "yes" ]; then
      echo "reconciling plugin market $HAVE -> $WANT"
      mkdir -p "$WEBPROF/node_modules"
      rm -rf "$MARKET_DIR"
      cp -a "$TPL/web/node_modules/dshmarket" "$MARKET_DIR"
      # keep the market's own runtime deps aligned with the shipped ones
      for dep in js-yaml undici; do
        if [ -d "$TPL/web/node_modules/$dep" ]; then
          rm -rf "$WEBPROF/node_modules/$dep"
          cp -a "$TPL/web/node_modules/$dep" "$WEBPROF/node_modules/$dep"
        fi
      done
      node -e "
        const fs=require('node:fs');
        const p='$WEBPROF/package.json';
        try{
          const j=JSON.parse(fs.readFileSync(p,'utf8'));
          j.dependencies=j.dependencies||{};
          j.dependencies.dshmarket='$WANT';
          fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
        }catch(e){}
      " 2>/dev/null || true
    else
      echo "keeping user plugin market $HAVE (image ships $WANT)"
    fi
  fi
fi

# --- 3. Settings persistence repair + market preview images ----------------
if [ -f /lzcapp/pkg/content/dsh-proxy.mjs ]; then
  cp -f /lzcapp/pkg/content/dsh-proxy.mjs /dsh-proxy.mjs
fi
# Auto-update posture: an upstream layout change must degrade a convenience
# patch, never take the app down. Both patches are idempotent and optional.
run_patch() {
  if ! node "$1"; then
    echo "WARN: $1 failed; continuing without it (upstream layout may have changed)" >&2
  fi
}
run_patch /lzcapp/pkg/content/patch-dsh-settings.js
# The market asks a third-party image resizer for every thumbnail; that host is
# not reachable from here, so point the previews at the app's own proxy. Runs
# after the market reconcile above, and is idempotent.
run_patch /lzcapp/pkg/content/patch-dsh-market-images.js

# --- 4. run -----------------------------------------------------------------
exec /entry.sh
