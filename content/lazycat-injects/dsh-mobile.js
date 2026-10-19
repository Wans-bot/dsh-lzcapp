// 手机端适配补丁（浏览器侧注入）
//
// 上游 dsh 的 Web UI 是桌面优先的。窄屏（<=640px）下有四个真实问题：
//   1. 外壳是 grid：`<侧边栏> minmax(0,1fr) <右侧栏>`，侧边栏展开时 JS 把第一列
//      从 56px 改成 280px。390px 宽的手机里，对话列被压到 110px，每行只剩三四个字。
//   2. 对话区结构是 body > scrollBody（滚动）+ composerSeat（sticky 输入区），
//      两者叠在同一个盒子里而 scrollBody 的 padding-bottom 是 0；手机上输入框
//      因为工具条换行变得更高，正文就从半透明输入框底下透出来。
//   3. 没有视口适配：100vh 忽略移动浏览器地址栏和底部小白条，下拉还会触发回弹/刷新。
//   4. 侧栏展开后不会自己收起（桌面思维），用户挑完会话还停留在被压窄的状态。
//
// 本补丁只处理窄屏，桌面宽度下所有规则都不生效，保持上游原样。
(function () {
  'use strict';

  var NARROW = '(max-width: 640px)';
  var RAIL = 56; // 保持上游折叠态宽度：改小会让 44px 触摸目标撑破网格列

  var CSS = [
    '@media ' + NARROW + ' {',
    // ① 第一列恒为图标栏宽度；!important 压过 JS 写在内联 style 上的 grid-template-columns
    '  [class*="frame"] {',
    '    grid-template-columns: ' + RAIL + 'px minmax(0, 1fr) minmax(0, 0px) !important;',
    '    height: 100dvh !important; box-sizing: border-box;',
    '    padding-top: env(safe-area-inset-top, 0px);',
    '    padding-bottom: env(safe-area-inset-bottom, 0px);',
    '    padding-left: env(safe-area-inset-left, 0px);',
    '    padding-right: env(safe-area-inset-right, 0px);',
    '  }',
    // ② 侧栏改成 fixed 后退出网格流，后面两列会整体左移一格，必须显式钉住列位
    '  [class*="centerCol"] { grid-column: 2 !important; padding-inline: 8px; }',
    '  [class*="rightbarCol"] { grid-column: 3 !important; }',
    // ③ 侧栏脱离网格流成为浮层：收起=图标栏，展开=抽屉覆盖在内容之上，不再挤压对话列
    '  [class*="sidebarCol"] {',
    '    position: fixed !important; left: 0; top: 0; bottom: 0;',
    '    width: max-content !important; max-width: 88vw;',
    '    overflow: visible !important; z-index: 40;',
    '    padding-left: env(safe-area-inset-left, 0px);',
    '  }',
    // ④ 触摸目标：只放大图标栏里的按钮；内容区按钮放大后会把模型名等文字挤掉
    '  [class*="sidebarCol"] button, [class*="sidebarCol"] [role="button"] { min-height: 44px; }',
    // 注：曾尝试给滚动区加 padding-bottom 让位，但输入区是 sticky 粘在 padding 边缘，
    // 加 padding 反而把它顶到页面中部，故不做此修正（玻璃拟态透字是上游原生表现）。
    // ⑤ 输入框下方统计条（轮次/吞吐/缓存命中）在窄屏会被省略号截断，缩字号换完整
    '  [class*="composerStack"] [class*="dock"],',
    '  [class*="composerStack"] [class*="meta"] { font-size: 11px !important; }',
    '}',
    // 粗指针设备通用：禁掉下拉刷新回弹与点击高亮
    '@media (pointer: coarse) {',
    '  html, body { overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }',
    '}'
  ].join('\n');

  // 注入点可能早于 <head> 存在（平台在 document-start 执行本脚本）：
  // 拿不到宿主就返回 false，由 boot 里的定时器或 DOMContentLoaded 补一次。
  function injectCss() {
    if (document.getElementById('lzc-dsh-mobile')) return true;
    var host = document.head || document.documentElement;
    if (!host) return false;
    var style = document.createElement('style');
    style.id = 'lzc-dsh-mobile';
    style.textContent = CSS;
    host.appendChild(style);
    return true;
  }

  // iOS 上 env(safe-area-inset-*) 只在 viewport-fit=cover 时才有非零值
  function patchViewport() {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta || meta.content.indexOf('viewport-fit') !== -1) return;
    meta.content = meta.content + ', viewport-fit=cover';
  }

  function isNarrow() {
    return typeof matchMedia !== 'undefined' && matchMedia(NARROW).matches;
  }


  function sidebar() {
    return document.querySelector('[class*="sidebarCol"]');
  }

  function isSidebarOpen() {
    var sb = sidebar();
    return !!sb && sb.getBoundingClientRect().width > RAIL + 40;
  }

  function collapseSidebar() {
    var toggle =
      document.querySelector('[class*="_toggle"][aria-label]') ||
      document.querySelector('[aria-label="收起侧边栏"]');
    if (toggle) toggle.click();
  }

  // 窄屏下：点抽屉里的条目或点内容区都把抽屉收起（上游是常驻侧栏的桌面行为）
  function onClick(event) {
    if (!isNarrow() || !isSidebarOpen()) return;
    var sb = sidebar();
    var target = event.target;
    if (!sb || !target || typeof target.closest !== 'function') return;
    // 折叠按钮自己交给上游处理，避免连点两次互相抵消
    if (target.closest('[class*="_toggle"]') || target.closest('[aria-label="收起侧边栏"]')) return;
    // 图标栏本身（打开各面板的按钮）不收起，否则刚打开的面板立刻被关掉
    var box = sb.getBoundingClientRect();
    if (event.clientX - box.left < RAIL + 4) return;
    setTimeout(collapseSidebar, 40);
  }

  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    if (!injectCss()) {
      var tries = 0;
      var timer = setInterval(function () {
        if (injectCss() || ++tries > 40) clearInterval(timer);
      }, 50);
    }
    patchViewport();
    document.addEventListener('click', onClick, true);
  }

  if (document.readyState === 'loading') {
    // 样式尽早注入，避免首帧闪一下桌面布局
    injectCss();
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
