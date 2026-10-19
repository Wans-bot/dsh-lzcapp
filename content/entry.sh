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
DOCS_DIR="${DSH_DOCUMENTS_DIR:-$DSH_HOME_DIR/documents}"

# --- 1. Documents directory for first-use Workspace creation ---------------
# dsh 0.2 resolves <Documents>/deepseek-harness/default-workspace through
# `xdg-user-dir DOCUMENTS`; the Debian base image has no xdg-user-dirs, so the
# first page load reports "Unable to create default workspace" and the empty
# state never seeds. The OS directory is also the wrong answer here: it lives
# outside /lzcapp/var and would not survive an app upgrade. Answer with a path
# on the persistent volume instead, and never shadow a real xdg-user-dir.
mkdir -p "$DOCS_DIR" /usr/local/bin
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
