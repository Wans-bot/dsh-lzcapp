#!/usr/bin/env node
// LPK 提审：开发者中心三段式 COS 直传 + 建审核单（纯 node，无需 python）。
//
// 链路（官方要求的 curl 直调顺序）：
//   1) GET  /api/v3/developer/sts/applyWrite?file_name=<uuid>.lpk   -> 腾讯 COS 临时凭证
//   2) PUT  LPK 直传 COS（手写 COS V5 签名，appstore/lpks/review/<uuid>.lpk）
//   3) POST /api/v3/developer/app/lpk/read_from_cos_async?file_path=<cos url> -> task_id
//   4) GET  .../status/<task_id> 轮询 completed -> sha256 / iconPath / imageSize
//   5) POST /api/v3/developer/upload  上传 PC/移动端截图 -> /public/<uuid>.png
//   6) POST /api/v3/developer/app/<package>/review/create  建立审核单
//
// 用法:
//   node submit-review.mjs --lpk dist/app-1.0.0.lpk --package cloud.lazycat.app.x \
//        --version 1.0.1 --name-zh "应用名" --brief-zh "一句话" --desc-zh "详细描述" \
//        --keywords-zh "a,b" --source https://github.com/x/y --author 上游作者 \
//        --shots-pc pc1.png pc2.png pc3.png --shots-mobile m1.png m2.png m3.png \
//        --changelog-zh "本次修复：…" [--support-mobile] [--dry-run]
//
// 注意:
//   * 新应用必须先在 https://developer.lazycat.cloud/manage 网页建档，否则 500 record not found。
//   * review/create 会真实建立审核单并通知官方审核员；不确定时先加 --dry-run。
//   * 提交后务必用 review-status.mjs 回读核对 pkg_hash 与本地 LPK 的 sha256 一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://appstore.api.lazycat.cloud/api/v3/developer';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const list = (n) => { const i = argv.indexOf(n); const out = []; if (i < 0) return out; for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]); return out; };

function loadToken() {
  if (process.env.LZC_USER_TOKEN) return process.env.LZC_USER_TOKEN;
  const cfg = path.join(os.homedir(), '.config/lazycat/box-config.json');
  if (fs.existsSync(cfg)) { const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); if (j.token) return j.token; }
  throw new Error('未找到开发者 token：先 `lzc-cli appstore login -u <手机号> -p \'<密码>\'`，或设 LZC_USER_TOKEN');
}

const args = {
  lpk: opt('--lpk'), package: opt('--package'), version: opt('--version'),
  nameZh: opt('--name-zh'), nameEn: opt('--name-en'),
  briefZh: opt('--brief-zh'), descZh: opt('--desc-zh'), keywordsZh: opt('--keywords-zh'),
  briefEn: opt('--brief-en'), descEn: opt('--desc-en'), keywordsEn: opt('--keywords-en'),
  source: opt('--source'), author: opt('--author'),
  shotsPc: list('--shots-pc'), shotsMobile: list('--shots-mobile'),
  unsupported: list('--unsupported'),
  changelogZh: opt('--changelog-zh', '首次上架'),
  changelogEn: opt('--changelog-en', 'First release'),
  minOs: opt('--min-os', '1.6.0'),
  supportMobile: has('--support-mobile'),
  dryRun: has('--dry-run'),
  uploadOnly: has('--upload-only'),
};

const die = (m) => { console.error('✗ ' + m); process.exit(1); };
for (const k of ['lpk', 'package', 'version', 'nameZh']) if (!args[k]) die(`缺少必填参数 --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);

// 英文资料硬门槛（2026-10-13 新增；历史驳回 #20046 librenms / #20230 podfetch1 / #20237 zammad 都是这一条）
// 旧实现 `args.briefEn || args.briefZh` 会在漏传 --*-en 时把中文静默填进 English 语言资料，
// 审核在页面切到 English 后直接看到中文 → 驳回。这里改成：缺参数或含中文一律拒绝提审。
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
for (const [flag, val] of [['--name-en', args.nameEn], ['--brief-en', args.briefEn], ['--desc-en', args.descEn]]) {
  if (!val) die(`缺少必填参数 ${flag}：英文语言资料不能留空，也不会再回退到中文（历史驳回原因）`);
  if (hasCJK(val)) die(`${flag} 含中文字符：English 语言资料必须是英文（历史驳回原因「英文描述里面是中文」）`);
}
if (!args.keywordsEn) die('缺少必填参数 --keywords-en：英文语言资料不能留空');

const TOKEN = loadToken();
const HEAD = { 'X-User-Token': TOKEN, 'Cookie': `userToken=${TOKEN}` };

async function req(method, url, { json, body, headers = {}, raw = false } = {}) {
  const h = { ...HEAD, ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(900000) });
  const text = raw ? await res.text() : await res.text();
  return { status: res.status, text, buf: null };
}

// --- COS V5 签名直传（字段坑：TmpSecretId/Key 原样使用；q-sign-time 用凭证的时间窗口）---
// bucket/region 来自服务端响应，属于外部输入：先校验目标主机确实是腾讯云 COS 域名再发请求。
const COS_HOST_RE = /^[a-z0-9][a-z0-9-]{0,61}\.cos\.[a-z0-9-]{1,20}\.myqcloud\.com$/;
const bucketName = (b) => String(b || '').replace(/\.cos\..*$/, '');
function cosHost(cred) {
  const host = `${bucketName(cred.bucket)}.cos.${String(cred.region || '')}.myqcloud.com`;
  if (!COS_HOST_RE.test(host)) throw new Error(`拒绝向非 COS 域名的地址上传: ${host}`);
  return host;
}

function cosPut(cred, localPath, cosPath) {
  const host = cosHost(cred);
  const keyTime = `${cred.StartTime};${cred.ExpiredTime}`;
  const signKey = crypto.createHmac('sha1', cred.TmpSecretKey).update(keyTime).digest('hex');
  const signHeaders = { host, 'x-cos-security-token': cred.Token };
  const httpHeaders = Object.keys(signHeaders).sort()
    .map((k) => `${k}=${encodeURIComponent(String(signHeaders[k]))}`).join('&');
  const fmt = `put\n/${cosPath}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${crypto.createHash('sha1').update(fmt).digest('hex')}\n`;
  const sig = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const auth = 'q-sign-algorithm=sha1' +
    `&q-ak=${cred.TmpSecretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
    '&q-header-list=host;x-cos-security-token&q-url-param-list=' + `&q-signature=${sig}`;
  const buf = fs.readFileSync(localPath);
  return fetch(`https://${host}/${cosPath}`, {
    method: 'PUT',
    headers: {
      Authorization: auth, 'x-cos-security-token': cred.Token, Host: host,
      'Content-Length': String(buf.length), 'Content-Type': 'application/octet-stream',
    },
    body: buf, signal: AbortSignal.timeout(900000),
  });
}

async function uploadLpk(localPath) {
  const name = `${crypto.randomUUID().replace(/-/g, '')}.lpk`;
  const sts = await req('GET', `${API}/sts/applyWrite?file_name=${name}`);
  if (sts.status !== 200) die(`sts/applyWrite 失败 ${sts.status}: ${sts.text.slice(0, 300)}`);
  const cred = JSON.parse(sts.text).data ?? JSON.parse(sts.text);
  const cosPath = cred.path || `appstore/lpks/review/${name}`;
  console.log(`  [1/4] STS 凭证就绪 host=${cosHost(cred)}`);
  if (args.dryRun) { console.log('  [2/4] --dry-run 跳过 COS 上传'); return { dryRun: true }; }
  const put = await cosPut(cred, localPath, cosPath);
  if (put.status !== 200) die(`COS PUT 失败 ${put.status}: ${(await put.text()).slice(0, 300)}`);
  console.log(`  [2/4] COS 直传完成 ${cosPath}`);
  const cosUrl = `https://${cosHost(cred)}/${cosPath}`;
  const trig = await req('POST', `${API}/app/lpk/read_from_cos_async?file_path=${encodeURIComponent(cosUrl)}`);
  if (![200, 202].includes(trig.status)) die(`read_from_cos_async 失败 ${trig.status}: ${trig.text.slice(0, 300)}`);
  const tj = JSON.parse(trig.text);
  const task = tj.task_id || (tj.data && tj.data.task_id);
  console.log(`  [3/4] 解析任务 ${task}`);
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = JSON.parse((await req('GET', `${API}/app/lpk/read_from_cos_async/status/${task}`)).text);
    const d = s.data ?? s;
    const status = s.status || d.status;
    if (status === 'completed') {
      const res = s.result || d.result;
      console.log(`  [4/4] 解析完成 sha256=${String(res.sha256).slice(0, 16)}… icon=${res.iconPath}`);
      return res;
    }
    if (status === 'failed' || status === 'error') die(`LPK 解析失败: ${JSON.stringify(s).slice(0, 300)}`);
  }
  return die('LPK 解析超时（>7.5 分钟）');
}

async function uploadShot(p) {
  const buf = fs.readFileSync(p);
  const boundary = '----lzc' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(p)}"\r\nContent-Type: image/png\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await fetch(`${API}/upload`, {
    method: 'POST', headers: { ...HEAD, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, buf, tail]), signal: AbortSignal.timeout(300000),
  });
  const txt = await res.text();
  if (res.status !== 200) die(`截图上传失败 ${p} (${res.status}): ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  const url = j.url || (j.data && j.data.url);
  if (!url) die(`截图上传返回无 url: ${txt.slice(0, 200)}`);
  return url;
}

// 硬门槛：PC ≥3 张、移动端 ≥3 张（官方 review/create 对不足者直接 400）
function checkShots() {
  if (args.shotsPc.length < 3) die(`PC 截图至少 3 张（当前 ${args.shotsPc.length} 张）；每边需 1080-7680px`);
  if (args.supportMobile && args.shotsMobile.length < 3) die(`声明支持移动端就必须给 ≥3 张移动截图（当前 ${args.shotsMobile.length} 张），否则去掉 --support-mobile`);
  for (const p of [...args.shotsPc, ...args.shotsMobile]) if (!fs.existsSync(p)) die(`截图不存在: ${p}`);
}

const main = async () => {
  console.log(`== 提审 ${args.package} v${args.version} ==`);
  const lpkBytes = fs.readFileSync(args.lpk);
  const localSha = crypto.createHash('sha256').update(lpkBytes).digest('hex');
  console.log(`  本地 LPK: ${args.lpk} (${(lpkBytes.length / 1024).toFixed(0)}KB) sha256=${localSha.slice(0, 16)}…`);

  // 包名占用/建档状态（只读探测；不存在则必须先网页建档）
  const ex = await req('GET', `${API}/app/check/exist?package=${encodeURIComponent(args.package)}`);
  let existed = null;
  try { existed = JSON.parse(ex.text).exist; } catch { /* 忽略 */ }
  console.log(`  check/exist -> ${ex.status} exist=${existed}`);
  if (existed === false) die('该包名尚未建档：先在 https://developer.lazycat.cloud/manage 新建应用，再回来提审');

  checkShots();

  const res = await uploadLpk(args.lpk);
  if (args.dryRun) {
    console.log('\n[dry-run] 后续将执行：上传截图 ' + args.shotsPc.length + ' 张 PC / ' + args.shotsMobile.length + ' 张移动 → review/create');
    return;
  }
  if (!res || !res.sha256) die('LPK 解析未返回 sha256，无法提审');
  if (res.sha256 !== localSha) console.log(`  ⚠️ 服务端 sha256(${String(res.sha256).slice(0, 16)}…) 与本地不一致，请确认上传的就是修复后的包`);

  const pc = [];
  for (const p of args.shotsPc) pc.push(await uploadShot(p));
  const mob = [];
  for (const p of args.shotsMobile) mob.push(await uploadShot(p));
  console.log(`  截图上传完成 PC=${pc.length} 移动=${mob.length}`);
  console.log('  （截图可从 appstore.lazycat.cloud/public/<uuid>.png 公开访问；台账核对以 review 详情里的 *_paths 为准）');

  if (args.uploadOnly) {
    console.log('\n[--upload-only] 已完成 LPK 直传+解析+截图上传，未建立审核单。');
    console.log(`  COS 文件名: ${res.fileName || res.url || res.pkg_path}`);
    console.log(`  iconPath:   ${res.iconPath}`);
    console.log('  想正式提审，去掉 --upload-only 再跑一次即可。');
    return;
  }

  // 不回退中文：上面的硬门槛已保证 --*-en 齐全且不含中文（历史驳回原因「英文描述里面是中文」）。
  const en = { name: args.nameEn, brief: args.briefEn, description: args.descEn, keywords: args.keywordsEn };
  const infos = [
    { language: 'zh', name: args.nameZh, brief: args.briefZh, description: args.descZh, keywords: args.keywordsZh, source: args.source, source_author: args.author, support_pc: true, support_mobile: args.supportMobile, screenshot_pc_paths: pc, screenshot_mobile_paths: mob },
    { language: 'en', name: en.name, brief: en.brief, description: en.description, keywords: en.keywords, source: args.source, source_author: args.author, support_pc: true, support_mobile: args.supportMobile, screenshot_pc_paths: pc, screenshot_mobile_paths: mob },
  ];
  const version = {
    id: -1, package: args.package, name: args.version,
    pkg_path: res.fileName || res.url || res.pkg_path,
    icon_path: res.iconPath, min_os_version: args.minOs, pkg_hash: res.sha256,
    lpk_size: lpkBytes.length, image_size: res.imageSize,
    unsupported_platforms: args.unsupported,
    changelogs: { zh: args.changelogZh, en: args.changelogEn },
  };
  const created = await req('POST', `${API}/app/${encodeURIComponent(args.package)}/review/create`, { json: { infos, version } });
  console.log(`  review/create -> ${created.status}`);
  const body = created.text.slice(0, 500);
  console.log('  ' + body);
  if (created.status === 200 && /"status"\s*:\s*0/.test(created.text)) {
    console.log('\n✅ 已进入审核队列。下一步：');
    console.log('   node review-status.mjs --package ' + args.package + '   # 回读核对 pkg_hash / icon_hash');
    console.log('   （对照 references/submission-gate.md 里「提交后必须回读」一节）');
  } else {
    console.log('\n⚠️ 未确认成功，按上面的响应排查（400 常见原因：截图不足 / 字段缺失 / 未建档）');
    process.exit(1);
  }
};

main().catch((e) => die(e.message));
