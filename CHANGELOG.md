# 变更记录

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
