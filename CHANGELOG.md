# 变更记录

## 1.1.14（2026-10-30）

- dsh `0.2.1-rc.5`
- 内置插件市场 dshmarket `1.73.5`

## 1.1.13（2026-10-20）

- **工作区迁进网盘「应用文稿」**（审核单 #20857 驳回：更新后工作区文件丢失，要求
  「对工作区文件进行持久化储存，储存到网盘应用文稿内」）。`entry.sh` 现在把 dsh 的
  Documents 指向 `/lzcapp/document/<用户>/.apps/<包ID>`——平台挂进来的网盘存储里
  「应用文稿」分区，带备份、跟着还原走、卸载默认不删，工作区随 `xdg-user-dir
  DOCUMENTS` 落到那里，不再落在会被重建的位置
- 升级兼容：`/data/documents` 改为指向应用文稿的软链，1.1.12 及更早版本存下的
  `…/documents/deepseek-harness/default-workspace` 绝对路径继续可用；首次启动把老
  目录内容拷进应用文稿，拷贝失败则保留原目录、不强上软链
- 权限：`document.private` 由 optional 改为 **required**（没有这个权限平台不挂网盘
  存储，工作区无从持久化）；挂载缺失时回退私有卷并打告警，容器照常启动
- `package.yml` / `lzc-manifest.yml` 说明文案补上工作区位置与持久化范围
- dsh `0.2.1-rc.2`（镜像不变）；内置插件市场 dshmarket `1.66.42`
## 1.1.12（2026-10-19）

- dsh `0.2.1-rc.2`
- 内置插件市场 dshmarket `1.66.42`

## 1.1.11（2026-10-19）

- **撤回** 1.1.9 引入的窄屏适配补丁（`content/lazycat-injects/dsh-mobile.js`）：
  实测在真机上观感比上游原生更差，上游布局细节（`composerSeat` 为 `sticky` 浮层、
  消息容器流内 0 高度）改一处牵动全身，补丁整体移除，界面回到上游原样
- 商店截图重拍：中文界面，PC 1920×1080 三张 + 手机 1080×1920 三张
- dsh `0.2.1-rc.2`；内置插件市场 dshmarket `1.66.42`（与 1.1.8/1.1.9/1.1.10 相同）

## 1.1.10（2026-10-19）

- dsh `0.2.1-rc.2`
- 内置插件市场 dshmarket `1.66.42`

## 1.1.9（2026-10-19）

- 新增窄屏（≤640px）适配补丁 `content/lazycat-injects/dsh-mobile.js`：上游 Web UI 是
  桌面优先布局，手机竖屏下侧边栏展开会把对话列从 334px 压到 80px（每行只剩三四个字）。
  补丁在窄屏下把侧边栏改成浮层抽屉（覆盖内容而不挤压），并补上安全区避让、
  100dvh、图标栏 44px 触摸目标、点选后自动收起，以及禁用下拉回弹
- 桌面宽度下所有规则不生效，保持上游原样
- 商店截图改为中文界面，并补拍手机竖屏（1080×1920）三张
- dsh `0.2.1-rc.2`；内置插件市场 dshmarket `1.66.42`（与 1.1.8 相同）

## 1.1.8（2026-10-19）

- dsh `0.2.1-rc.2`
- 内置插件市场 dshmarket `1.66.42`

## 1.1.7（2026-10-19）

- dsh `0.2.1-rc.2`（镜像 `registry.lazycat.cloud/wans/dsh-runtime-0.2.1-rc.2-39212123817:2c60bb6a4a5a9810`）
- 回写 main 的重试从 3 次 / 5s 退避提升到 6 次 / 递增退避，并在每次重试前显式
  `git fetch` + `git rebase`：1.1.6 那次就是因为并行提交把回写挤掉，Release 发了
  而 main 停在旧版本
- 无功能变更（承 1.1.6 的补丁降级与降级护栏）

## 1.1.6（2026-10-19）

- dsh `0.2.1-rc.2`（镜像 `registry.lazycat.cloud/wans/dsh-runtime-0.2.1-rc.2-39210816097:038aba157bb12acd`）
- 补丁失败降级为告警：`entry.sh` 的两个 patch 用 `run_patch` 包裹，上游布局变动时
  最坏是「设置不再持久化」，不再让容器 Exited
- `upstream.mjs` 加回退护栏：目标版本低于仓库已记录的 `dsh.version` 一律拒绝，
  防止 dist-tag 倒退把线上版本降级
- 发布提交回 main 改为 rebase 重试，避免与并发提交撞车
- 从这一版起走 GitHub Actions 自动发布（`Wans-bot/dsh-lzcapp`）

## 1.1.5（2026-10-19）

- 修 1.1.4 的路径错误：dsh 的 UI 插件是**嵌套依赖**（`<dsh>/node_modules/@deepseek-ai/…`），
  补丁改为扫描该目录下所有 `dsh-client-ui-settings*` 包，不再硬编码单一路径
- 其余同 1.1.4（dsh `0.2.1-rc.2`、dshmarket `1.66.42`）

## 1.1.4（2026-10-19）

- dsh `0.2.1-rc.2`（镜像 `registry.lazycat.cloud/wans/dsh-runtime-0.2.1-rc.2-39206298788:e4eebfa16a294298`）
- 修 0.2.1-rc.2 启动即崩：设置持久化补丁跟随上游改版（选择器从 `dsh-client-ui-settings` 挪到
  `dsh-client-ui-settings-general`，形态从 `? "host" : "memory"` 变为 `? new SettingsDocumentStore(...) : void 0`），
  现在同时兼容两种形态；找不到选择器时仍按失败关闭处理
- 内置插件市场 dshmarket `1.66.42`

## 1.1.3（2026-10-19）

- dsh `0.2.1-rc.2`
- 内置插件市场 dshmarket `1.66.42`

## 1.1.2

- dsh `0.2.1-rc.1`
- 内置插件市场 dshmarket `1.66.42`

## 1.1.1

- dsh `0.2.1-rc.1`
- 修掉浏览器中断连接把容器带崩的问题（代理层所有 socket 都挂 error 监听）
- 插件市场缩略图改走应用内代理（原图床大陆不可达）

## 1.1.0

- 免登录：代理层自动注入 launch token，不再需要用户手抄 token
- Settings 持久化修复（懒猫分配域名与 dsh 的 cookie 域对齐）

## 1.0.0

- 首个可用版本：dsh `0.2.0-rc.2` + web UI + 预装插件市场
