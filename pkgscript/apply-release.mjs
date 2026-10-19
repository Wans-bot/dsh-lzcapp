#!/usr/bin/env node
// 把一次发布要改的文件一次性改完，供 CI 与本地复用。
//
// 只做确定性改写，不做网络访问：输入什么就写什么，改完打印 diff 摘要，
// 有异常就退出非 0（宁可失败，也不要悄悄发出一个版本号对不上的包）。
//
// 环境变量
//   DSH_VERSION     dsh 版本，写入 dsh.version
//   MARKET_VERSION  dshmarket 版本，写入 web profile 模板的 dependencies
//   LPK_VERSION     本次 LPK 版本，写入 package.yml 的 version
//   IMAGE           copy-image 返回的 registry.lazycat.cloud 地址，写入 manifest
//   CHANGELOG_NOTE  可选，写进 CHANGELOG.md 的正文（默认自动生成一行）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function env(name, { required = true } = {}) {
  const value = process.env[name]?.trim();
  if (required && !value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function writeIfChanged(rel, next) {
  const abs = path.join(ROOT, rel);
  const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (prev === next) {
    console.log(`= ${rel} 未变`);
    return false;
  }
  fs.writeFileSync(abs, next);
  console.log(`✎ ${rel}`);
  return true;
}

function replaceOnce(text, regex, replacement, label) {
  const hits = text.match(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`));
  if (!hits || hits.length !== 1) {
    throw new Error(`${label}：期望命中 1 处，实际 ${hits ? hits.length : 0} 处`);
  }
  return text.replace(regex, replacement);
}

function updateProfilePackage(marketVersion) {
  const rel = 'image/profile-template/profiles/web/package.json';
  const text = read(rel);
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (err) {
    throw new Error(`${rel} 不是合法 JSON：${err.message}`);
  }
  pkg.dependencies = pkg.dependencies || {};
  const before = pkg.dependencies.dshmarket;
  pkg.dependencies.dshmarket = marketVersion;
  console.log(`  dshmarket: ${before} -> ${marketVersion}`);
  return writeIfChanged(rel, `${JSON.stringify(pkg, null, 2)}\n`);
}

function updatePackageYml(lpkVersion) {
  const rel = 'package.yml';
  const text = read(rel);
  const next = replaceOnce(text, /^version:\s*\S+\s*$/m, `version: ${lpkVersion}`, `${rel} version`);
  return writeIfChanged(rel, next);
}

function updateManifestImage(image) {
  const rel = 'lzc-manifest.yml';
  const text = read(rel);
  // services.dsh 下的 4 空格缩进 image: 行；Go 模板控制行不在这份 manifest 里，
  // 但依然只做单行替换，避免整份 YAML 往返序列化。
  const next = replaceOnce(text, /^ {4}image:\s*\S+\s*$/m, `    image: ${image}`, `${rel} image`);
  return writeIfChanged(rel, next);
}

function updateDshVersion(dshVersion) {
  return writeIfChanged('dsh.version', `${dshVersion}\n`);
}

function appendChangelog({ lpkVersion, dshVersion, marketVersion, note }) {
  const rel = 'CHANGELOG.md';
  const date = new Date().toISOString().slice(0, 10);
  const body =
    note ||
    `- dsh \`${dshVersion}\`\n- 内置插件市场 dshmarket \`${marketVersion}\``;
  const prev = fs.existsSync(path.join(ROOT, rel)) ? read(rel) : '# 变更记录\n';
  const entry = `\n## ${lpkVersion}（${date}）\n\n${body}\n`;
  // 新条目紧跟标题之后，保持时间倒序
  const header = prev.startsWith('# 变更记录') ? '# 变更记录\n' : '';
  const rest = header ? prev.slice(header.length) : prev;
  return writeIfChanged(rel, `${header}${entry}${rest}`);
}

function main() {
  const dshVersion = env('DSH_VERSION');
  const marketVersion = env('MARKET_VERSION');
  const lpkVersion = env('LPK_VERSION');
  const image = env('IMAGE');
  const note = env('CHANGELOG_NOTE', { required: false });

  if (!/^\d+\.\d+\.\d+$/.test(lpkVersion)) {
    throw new Error(`LPK_VERSION 必须是 x.y.z：${lpkVersion}`);
  }
  if (!image.startsWith('registry.lazycat.cloud/')) {
    throw new Error(`IMAGE 必须是 registry.lazycat.cloud 地址（官方商店只接受中转镜像）：${image}`);
  }
  if (image.includes(':embed')) {
    throw new Error('IMAGE 不能是 embed 目标');
  }

  console.log(`发布 ${lpkVersion}：dsh ${dshVersion} / dshmarket ${marketVersion}`);
  updateDshVersion(dshVersion);
  updateProfilePackage(marketVersion);
  updatePackageYml(lpkVersion);
  updateManifestImage(image);
  appendChangelog({ lpkVersion, dshVersion, marketVersion, note });
  console.log('✓ 改写完成');
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
