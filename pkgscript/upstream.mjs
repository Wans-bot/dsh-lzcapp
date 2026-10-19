#!/usr/bin/env node
// 解析上游 dsh 版本、挑选兼容的插件市场版本、算出本次要发的 LPK 版本。
//
// 只回答一个问题：要不要发、发什么。不碰网络以外的东西，不写仓库文件
// （改动由 apply-release.mjs 统一落盘，方便 review diff）。
//
// 输入（环境变量）
//   DSH_DIST_TAG        跟随 npm dist-tag，默认 latest；next/alpha 亦可
//   DSH_VERSION_OVERRIDE 显式指定 dsh 版本，优先于 dist-tag
//   FORCE                'true' 时即使版本未变也重建
// 输出（写入 $GITHUB_OUTPUT，本地运行则打印到 stdout）
//   changed / dsh_version / market_version / lpk_version / reason
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY = 'https://registry.npmjs.org';

/* ---------------------------------------------------------------- semver -- */

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function cmpIdent(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1; // 数字标识符优先级低于字母
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpPre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // 正式版 > 预发布
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const c = cmpIdent(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`无法解析版本号: ${a} / ${b}`);
  return (
    pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch || cmpPre(pa.pre, pb.pre)
  );
}

// 只需支持我们实际见到的写法：`^a.b.c[-pre]` 的 `||` 组合。
function caretUpper(v) {
  if (v.major > 0) return `${v.major + 1}.0.0`;
  if (v.minor > 0) return `0.${v.minor + 1}.0`;
  return `0.0.${v.patch + 1}`;
}

function satisfies(version, range) {
  const v = parse(version);
  if (!v || !range) return false;
  return String(range)
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((alt) => {
      const m = /^\^(.+)$/.exec(alt);
      if (!m) return alt === version; // 兜底：精确匹配
      const lower = parse(m[1]);
      if (!lower) return false;
      const lowerStr = m[1];
      // 预发布只在同一 major.minor.patch 元组内比较
      if (v.pre.length && !lower.pre.length) return false;
      if (v.pre.length && (v.major !== lower.major || v.minor !== lower.minor || v.patch !== lower.patch)) {
        return false;
      }
      return compare(version, lowerStr) >= 0 && compare(version, caretUpper(lower)) < 0;
    });
}

/* ------------------------------------------------------------------ http -- */

async function fetchJson(url, accept) {
  const res = await fetch(url, {
    headers: {
      accept: accept || 'application/json',
      'user-agent': 'dsh-lzcapp-updater',
    },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// 精简元数据：体积比全量文档小一到两个数量级，字段够用。
const ABBREVIATED = 'application/vnd.npm.install-v1+json';

async function resolveDshVersion() {
  const pinned = process.env.DSH_VERSION_OVERRIDE?.trim();
  const doc = await fetchJson(`${REGISTRY}/@deepseek-ai%2fdsh`, ABBREVIATED);
  if (pinned) {
    if (!doc.versions?.[pinned]) throw new Error(`dsh ${pinned} 不在上游版本列表里`);
    return { version: pinned, via: 'input' };
  }
  const tag = (process.env.DSH_DIST_TAG || 'latest').trim();
  const version = doc['dist-tags']?.[tag];
  if (!version) {
    throw new Error(`dsh 没有 dist-tag ${tag}（现有：${Object.keys(doc['dist-tags'] || {}).join(', ')}）`);
  }
  // dist-tag 指向的值来自远端，进版本号与镜像标签前必须先证明它是 semver
  if (!parse(version)) throw new Error(`dsh dist-tag ${tag} 指向非法版本：${version}`);
  return { version, via: `dist-tag:${tag}` };
}

// 市场版本必须接受目标 dsh：peer 范围不匹配时 dsh 会跳过 bundle，
// 插件市场页面就整页消失（0.1.x -> 0.2.x 踩过一次）。
async function resolveMarketVersion(dshVersion) {
  const doc = await fetchJson(`${REGISTRY}/dshmarket`, ABBREVIATED);
  const candidates = Object.keys(doc.versions || {})
    .map((v) => ({ version: v, peer: doc.versions[v].peerDependencies || {} }))
    .filter((c) => parse(c.version))
    .filter((c) => satisfies(dshVersion, c.peer['@deepseek-ai/dsh-settings']))
    .sort((a, b) => compare(b.version, a.version));
  if (!candidates.length) {
    throw new Error(`没有 dshmarket 版本接受 dsh-settings ${dshVersion}`);
  }
  return candidates[0].version;
}

/* ------------------------------------------------------------------ main -- */

function readYamlVersion(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^version:\s*(\S+)\s*$/m.exec(text);
  if (!m) throw new Error(`${file} 里找不到顶层 version:`);
  return m[1];
}

function bumpPatch(version) {
  const v = parse(version);
  if (!v) throw new Error(`package.yml 的 version 不是 semver: ${version}`);
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

async function main() {
  const recorded = fs.existsSync(path.join(ROOT, 'dsh.version'))
    ? fs.readFileSync(path.join(ROOT, 'dsh.version'), 'utf8').trim()
    : '';
  const currentLpk = readYamlVersion(path.join(ROOT, 'package.yml'));
  const { version: dshVersion, via } = await resolveDshVersion();

  const out = {
    changed: 'false',
    dsh_version: dshVersion,
    market_version: '',
    lpk_version: currentLpk,
    reason: '',
  };

  if (recorded === dshVersion && process.env.FORCE !== 'true') {
    out.reason = `已是最新：仓库记录 dsh ${recorded || '(空)'} = 上游 ${dshVersion}（${via}）`;
    return report(out);
  }

  out.market_version = await resolveMarketVersion(dshVersion);
  out.lpk_version = bumpPatch(currentLpk);
  out.changed = 'true';
  out.reason = recorded
    ? `dsh ${recorded} -> ${dshVersion}（${via}），dshmarket -> ${out.market_version}`
    : `首次锚定 dsh ${dshVersion}（${via}），dshmarket -> ${out.market_version}`;
  return report(out);
}

function report(out) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
  if (file) fs.appendFileSync(file, `${lines.join('\n')}\n`);
  for (const line of lines) console.log(line);
  if (!file) console.log('\n（本地运行，未写 GITHUB_OUTPUT）');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
