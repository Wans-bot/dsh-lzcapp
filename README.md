# dsh-lzcapp — DeepSeek Harness 懒猫应用（自动更新）

`f00700f.deepseek-harness` 的源码仓库。上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
每次发版，GitHub Actions 自动重建运行时镜像、出 LPK、发 Release。

## 为什么需要这个仓库

dsh 官方只发 npm 包，不发容器镜像；官方商店只接受 `registry.lazycat.cloud` 里的镜像。
所以每次升级必须自己把「node + npm 全局 dsh + 预装插件市场」打成一个镜像，中转进
官方源，再把它写进 manifest。这一步过去靠手工在盒子上做，现在由 CI 完成。

## 流水线

`.github/workflows/lazycat.yml`

| 阶段 | 做什么 |
| --- | --- |
| `resolve` | 读 npm registry 的 dsh dist-tag（默认 `latest`），挑一个 peer 范围接受该 dsh 的 `dshmarket`，比对 `dsh.version` 决定要不要发 |
| 构建镜像 | `docker buildx`（linux/amd64）→ 推到 `ttl.sh`（匿名可推，24 小时后过期，够中转一次） |
| 中转 | `lzc-cli appstore copy-image` → 拿到 `registry.lazycat.cloud/...` 地址 |
| 改写 | `pkgscript/apply-release.mjs` 一次性改 `dsh.version`、`package.yml`、`lzc-manifest.yml`、web profile 的 `dshmarket`、`CHANGELOG.md` |
| 出包 | `lzc-cli project release` → `dist/*.lpk`（出包本身不需要任何凭据） |
| 发布 | GitHub Release 挂 LPK + SHA256，并把版本改写提交回 `main` |
| 提审（可选） | 仓库变量 `SUBMIT_REVIEW=true` 时调 `lzc-cli appstore publish` |

## 需要配置的东西

- Secret `LZC_API_TOKEN`：懒猫账号令牌，只在「中转镜像」和（可选）「提审」两步用到。
- 仓库变量 `DSH_DIST_TAG`（可选）：`latest`（默认，稳定线）/ `next`（预发布线）/ `alpha`。
- 仓库变量 `SUBMIT_REVIEW`（可选）：`true` 才自动提审，默认只发 Release。
- 仓库变量 `BASE_IMAGE`（可选）：覆盖运行时基础镜像，默认 `node:24-bookworm`。

## 手动触发

```bash
# 跟随 dist-tag 正常跑一次
gh workflow run lazycat.yml -R Wans-bot/dsh-lzcapp

# 指定版本（跳过 dist-tag，也跳过「已是最新」的短路）
gh workflow run lazycat.yml -R Wans-bot/dsh-lzcapp -f dsh_version=0.2.1-rc.2

# 已发过的版本重跑
gh workflow run lazycat.yml -R Wans-bot/dsh-lzcapp -f dsh_version=0.2.1-rc.2 -f force=true
```

## 本地出包（不重建镜像）

镜像已经中转好、只想重新打一次 LPK 时：

```bash
mkdir -p dist
lzc-cli project release      # => dist/f00700f.deepseek-harness-v<ver>.lpk
```

## 目录

```
content/                 LPK 内随包发布的运行时胶水（升级即生效，不用换镜像）
  entry.sh               manifest 的 entrypoint
  dsh-proxy.mjs          免登录代理（launch token 自动注入 + 图片代理）
  patch-dsh-settings.js  Settings 持久化修复
  patch-dsh-market-images.js  插件市场缩略图走应用内代理
  lazycat-injects/       官方文件选择器注入（微服 Drive 集成）
image/                   运行时镜像构建上下文
  Dockerfile             node + npm 全局 dsh + socat + 预置 web profile
  entry.sh               镜像内启动器（dsh web 起在 3081，取 token 后 exec 代理）
  profile-template/      预装 dshmarket 的 web profile 模板
pkgscript/               CI 用的两个脚本
  upstream.mjs           要不要发、发什么（只读 + 打 GITHUB_OUTPUT）
  apply-release.mjs      按上面结论改写仓库文件（确定性，不联网）
```

## 两个易踩的坑

1. **`dshmarket` 的 peer 范围必须接受本次 dsh**。范围不匹配时 dsh 会静默跳过 bundle，
   插件市场整页消失（0.1.x → 0.2.x 踩过一次）。`upstream.mjs` 就是为这件事写的。
2. **subdomain 不能改**。`lzc-manifest.yml` 里 `application.subdomain: dsh` 决定持久化
   卷的挂载路径，改了等于把用户的会话、设置、插件和 API Key 全部变成孤儿数据。
