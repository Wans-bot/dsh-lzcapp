# Runtime image for the DeepSeek Harness (dsh) LazyCat app.
#
# Everything the app needs is baked in here so the LPK only references this
# image by tag:
#   /entry.sh                  inner entrypoint (loopback dsh web + auth proxy)
#   /dsh-proxy.mjs             auth-autoinject proxy 3080 -> 3081
#   /opt/dsh-profile-template  pre-vendored web profile (bundled plugin market)
#
# The upstream runtime is a plain npm package, so an upstream bump is just
# `--build-arg DSH_VERSION=...`.
# BASE_IMAGE defaults to the public node image (what CI can pull). Builds on a
# LazyCat box can pass the previously shipped runtime image instead, which is
# already cached there and skips the ~350 MB Docker Hub pull.
ARG BASE_IMAGE=node:24-bookworm
FROM ${BASE_IMAGE}

ARG DSH_VERSION
ARG DSMARKET_VERSION

RUN apt-get update \
 && apt-get install -y --no-install-recommends socat ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN test -n "$DSH_VERSION" \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && dsh --version \
 && rm -rf /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/.cache

COPY entry.sh /entry.sh
RUN chmod 0755 /entry.sh
COPY dsh-proxy.mjs /dsh-proxy.mjs
COPY profile-template /opt/dsh-profile-template

# Vendor the bundled plugin market into the image so a fresh /data volume is
# usable without network installs. The market version must accept the dsh
# release vendored above, otherwise dsh skips the bundle and the Plugin Market
# page disappears; the resolve step in CI picks a compatible version.
RUN set -eu; \
    T=/opt/dsh-profile-template/profiles/web; \
    if [ -n "${DSMARKET_VERSION}" ]; then \
      sed -i "s/\"dshmarket\": \"[^\"]*\"/\"dshmarket\": \"${DSMARKET_VERSION}\"/" "$T/package.json"; \
    fi; \
    cd "$T"; \
    npm install --no-audit --no-fund --omit=dev 2>&1 | tail -5; \
    node -e "console.log('vendored dshmarket', require('$T/node_modules/dshmarket/package.json').version)"; \
    rm -rf "$T/node_modules/.cache" "$T/package-lock.json"

ENV DSH_HOME=/data
WORKDIR /data
EXPOSE 3080
CMD ["node"]
