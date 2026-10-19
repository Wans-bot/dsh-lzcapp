// 重拍商店截图：中文界面 + 手机端补丁生效
//   PC     1920x1080 dpr1
//   移动   360x640 dpr3 => 1080x1920（官方移动下限）
import { chromium, devices } from 'playwright-core';
import fs from 'node:fs';

const PATCH = fs.readFileSync('/home/wans/dsh-lzcapp/content/lazycat-injects/dsh-mobile.js', 'utf8');
const OUT = '/home/wans/dsh-lzcapp/screenshots';

const PC = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const MOB = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' };

async function shoot(kind, spec, tag) {
  const b = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--ignore-certificate-errors', '--host-resolver-rules=MAP dsh.wans.heiyu.space 127.0.0.1:8443'],
  });
  const ctx = await b.newContext({ ...spec, ignoreHTTPSErrors: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  // 关掉过渡动画：否则截图会抓到流式输出/布局动画的中途态（文字被省略号截断）
  await ctx.addInitScript({ content: PATCH });
  const p = await ctx.newPage();
  await p.emulateMedia({ reducedMotion: 'reduce' });
  const shot = async (name) => {
    await p.screenshot({ path: `${OUT}/${name}.png` });
    const { width, height } = await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    console.log(`${name}.png  css=${width}x${height}`);
  };

  await p.goto('https://dsh.wans.heiyu.space/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(9000);

  // ① 首屏
  await shot(`${kind}-1-home`);

  // ② 会话页：抽屉 → 选中「测试连接」
  await p.locator('[aria-label="打开侧边栏"]').click().catch(() => {});
  await p.waitForTimeout(1500);
  await p.getByText('测试连接', { exact: false }).first().click().catch(() => {});
  await p.waitForTimeout(12000);
  // 滚到最底部：这是用户实际看到的状态（输入框贴底），避免抓到流式中间态
  await p.evaluate(() => {
    const sb = document.querySelector('[class*="scrollBody"]');
    if (sb) sb.scrollTop = sb.scrollHeight;
  });
  await p.waitForTimeout(2500);
  await shot(`${kind}-2-chat`);

  // ③ 插件页 + 添加插件弹窗（说明「一切皆插件」+ 可装插件）
  await p.locator('[aria-label="插件"]').first().click({ timeout: 8000 }).catch(async () => {
    await p.getByText('插件', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
  });
  await p.waitForTimeout(4000);
  await p.getByText('添加插件', { exact: false }).first().click({ timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(3500);
  await shot(`${kind}-3-market`);

  await b.close();
}

await shoot('pc', PC);
await shoot('mobile', MOB);
console.log('完成');
