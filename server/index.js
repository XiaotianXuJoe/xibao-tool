/**
 * 红白喜报图片生成工具 - 后端单体服务 (Express)
 *
 * 功能:
 *  1. 风格参考图(模板)上传/查看
 *  2. 原始截图批量上传(图片多选 / zip 解压)
 *  3. 异步批量生图任务(全局并发上限可调, 默认 6, 上限受模型账户约束 20), 进度可轮询
 *  4. 结果按原图分组查询、追加生成、打包 zip 下载
 */
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 配置与路径
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3400);
const DEFAULT_PROMPT = process.env.DEFAULT_PROMPT || '';
const MODEL_TIMEOUT_MS = 180_000;  // 单次模型调用超时
const DEFAULT_CONCURRENCY = 6;     // 并发生成数默认值
const CONCURRENCY_LIMIT = 20;      // 并发生成数上限(受模型账户并发约束)

/** 规范化并发数: 取整并收敛到 1..CONCURRENCY_LIMIT, 非法值回落 fallback。 */
function normConcurrency(v, fallback = DEFAULT_CONCURRENCY) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(CONCURRENCY_LIMIT, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// 运行时模型配置: 默认取 .env, 用户可在「设置」页修改并持久化到 server/settings.json
// (通用字段 model/baseUrl/apiKey/size, 换模型或接新模型时改这几项即可)
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
/** size 规范化: 720p/480p 等像素档保持小写 p, 1K/2K/4K 保持大写 K。 */
function normSize(v) {
  v = String(v || '2K').trim();
  return /^\d+p$/i.test(v) ? v.toLowerCase() : v.toUpperCase();
}
const ENV_SETTINGS = {
  model: process.env.MODEL || 'doubao-seedream-5.0-pro',
  baseUrl: (process.env.BASE_URL || 'https://ai.ctaigw.cn/v1').replace(/\/+$/, ''),
  apiKey: process.env.API_KEY || '',
  size: normSize(process.env.IMAGE_SIZE || '2K'),
  concurrency: normConcurrency(process.env.MAX_CONCURRENCY),
};
const ALLOWED_SIZES = new Set(['720p', '1K', '2K', '4K']);
/** 尺寸选项 -> 网关 size 参数。480p(480x854=41万像素)低于模型最小像素面积 921600, 不被支持, 720p 为最小档。 */
const SIZE_TO_API = { '720p': '720x1280', '1K': '1K', '2K': '2K', '4K': '4K' };

/** 当前生效的全局生图并发上限: 读取运行时设置并收敛到 1..CONCURRENCY_LIMIT。 */
function maxConcurrency() {
  return normConcurrency(settings.concurrency);
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const merged = { ...ENV_SETTINGS, ...raw };
    merged.size = normSize(merged.size);
    merged.concurrency = normConcurrency(merged.concurrency);
    return merged;
  } catch {
    return { ...ENV_SETTINGS };
  }
}
let settings = loadSettings();

/** 将当前设置落盘(权限 600, 仅属主可读写)。 */
function persistSettings() {
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(
      { model: settings.model, baseUrl: settings.baseUrl, apiKey: settings.apiKey, size: settings.size, concurrency: settings.concurrency },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/** API Key 打码显示, 永不回传明文。 */
function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

const UPLOADS_DIR = path.join(ROOT, 'uploads');
const GENERATED_DIR = path.join(ROOT, 'generated');
const TEMPLATES_DIR = path.join(ROOT, 'server', 'templates');
const TMP_DIR = path.join(UPLOADS_DIR, '_tmp');
const DEFAULT_TEMPLATE = path.join(TEMPLATES_DIR, 'default-template.png');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

for (const dir of [UPLOADS_DIR, GENERATED_DIR, TEMPLATES_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 清洗文件名: 去路径、去非法字符、去前导点。 */
function sanitizeName(name) {
  let base = path.basename(String(name || ''))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return base || 'file';
}

/** 去掉扩展名。 */
function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

/**
 * multer 在部分环境会把 UTF-8 文件名按 latin1 解读, 尝试还原为 UTF-8;
 * 若还原后出现替换字符则说明原本就是正确编码, 保持原样。
 */
function fixUploadedName(name) {
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('�') ? name : fixed;
  } catch {
    return name;
  }
}

function isImageFile(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

/** 数字自然排序: 1.png < 2.png < 10.png */
function naturalSort(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** 确保批次目录中文件名不重复, 重复时追加 -2、-3 ... */
async function uniqueNameIn(dir, name) {
  const ext = path.extname(name);
  const stem = stripExt(name);
  let candidate = name;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}

/** 当前模板路径: 优先用户上传的 current-template.*, 否则用默认模板。 */
function getTemplateInfo() {
  const files = fs.readdirSync(TEMPLATES_DIR);
  const current = files.find((f) => f.startsWith('current-template.') && isImageFile(f));
  const file = current || 'default-template.png';
  return {
    abs: path.join(TEMPLATES_DIR, file),
    url: `/templates/${encodeURIComponent(file)}?v=${fs.statSync(path.join(TEMPLATES_DIR, file)).mtimeMs}`,
    isDefault: !current,
  };
}

/** 批次元数据文件名(存于 uploads/<batchId>/ 内, 非图片不会被当作原图)。 */
const BATCH_META_FILE = 'meta.json';

/** 读取批次元数据 {name, createdAt}, 不存在时返回空对象。 */
async function readBatchMeta(batchId) {
  try {
    const raw = await fsp.readFile(path.join(UPLOADS_DIR, batchId, BATCH_META_FILE), 'utf8');
    const meta = JSON.parse(raw);
    return meta && typeof meta === 'object' ? meta : {};
  } catch {
    return {};
  }
}

/** 合并写入批次元数据。 */
async function writeBatchMeta(batchId, patch) {
  const meta = { ...(await readBatchMeta(batchId)), ...patch };
  await fsp.writeFile(
    path.join(UPLOADS_DIR, batchId, BATCH_META_FILE),
    JSON.stringify(meta, null, 2),
  );
  return meta;
}

/**
 * 列出一个批次: 原图 -> 生成图 分组。
 * 同一批次内原图名 -> 结果文件夹的映射是确定性的(按文件名排序 + 去重后缀)。
 */
async function listBatch(batchId) {
  const dir = path.join(UPLOADS_DIR, batchId);
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const originals = files.filter(isImageFile).sort(naturalSort);
  const usedFolders = new Set();
  const result = [];
  for (const name of originals) {
    let folder = stripExt(name) || 'img';
    let unique = folder;
    let i = 2;
    while (usedFolders.has(unique)) unique = `${folder}-${i++}`;
    folder = unique;
    usedFolders.add(folder);

    const gdir = path.join(GENERATED_DIR, batchId, folder);
    let generated = [];
    try {
      const gfiles = (await fsp.readdir(gdir)).filter(isImageFile).sort(naturalSort);
      generated = gfiles.map((g) => ({
        file: `${folder}/${g}`,
        url: `/generated/${encodeURIComponent(batchId)}/${encodeURIComponent(folder)}/${encodeURIComponent(g)}`,
      }));
    } catch {
      /* 目录尚未创建 */
    }
    result.push({
      name,
      folder,
      url: `/uploads/${encodeURIComponent(batchId)}/${encodeURIComponent(name)}`,
      generated,
    });
  }
  const meta = await readBatchMeta(batchId);
  let createdAt = Number(meta.createdAt) || 0;
  if (!createdAt) {
    try {
      const st = await fsp.stat(dir);
      createdAt = st.birthtimeMs || st.mtimeMs || 0;
    } catch { /* 忽略 */ }
  }
  return { batchId, name: String(meta.name || ''), createdAt, originals: result };
}

/** 列出全部批次(归档列表): 含自定义名称、时间、原图/生成图数量、封面。 */
async function listBatches() {
  let entries;
  try {
    entries = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '_tmp' || !isValidBatchId(e.name)) continue;
    const batch = await listBatch(e.name);
    if (!batch) continue;
    let generatedCount = 0;
    let cover = null;
    for (const o of batch.originals) {
      generatedCount += o.generated.length;
      if (!cover && o.generated.length > 0) cover = o.generated[0].url;
    }
    if (!cover && batch.originals.length > 0) cover = batch.originals[0].url;
    out.push({
      batchId: batch.batchId,
      name: batch.name,
      createdAt: batch.createdAt,
      originalsCount: batch.originals.length,
      generatedCount,
      cover,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

/**
 * 调用网关生成一张喜报图。
 * @returns {Promise<Buffer>} PNG/JPEG 图片二进制
 */
async function callImageModel(originalAbsPath, prompt) {
  if (!settings.apiKey) throw new Error('未配置 API Key，请先到「设置」页填写');

  const template = getTemplateInfo();
  if (!fs.existsSync(template.abs)) throw new Error('风格模板不存在，请先上传模板');

  const origBuf = await fsp.readFile(originalAbsPath);
  const tplBuf = await fsp.readFile(template.abs);

  const body = {
    model: settings.model,
    prompt,
    image: [
      `data:${mimeOf(originalAbsPath)};base64,${origBuf.toString('base64')}`,
      `data:${mimeOf(template.abs)};base64,${tplBuf.toString('base64')}`,
    ],
    size: ALLOWED_SIZES.has(settings.size) ? SIZE_TO_API[settings.size] : '2K',
    watermark: false,
    response_format: 'b64_json',
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`模型调用超时(${MODEL_TIMEOUT_MS / 1000}s)`)),
    MODEL_TIMEOUT_MS,
  );
  try {
    const resp = await fetch(`${settings.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    const item = json.data?.[0];
    if (item?.b64_json) {
      const buf = Buffer.from(item.b64_json, 'base64');
      if (!buf.length) throw new Error('响应图片为空');
      return buf;
    }
    if (item?.url) {
      // 兼容 url 返回: 网关 URL 可能短期过期, 立即下载落盘(与主请求共用 180s 超时)
      const ir = await fetch(item.url, { signal: controller.signal });
      if (!ir.ok) throw new Error(`下载生成图失败: HTTP ${ir.status}`);
      return Buffer.from(await ir.arrayBuffer());
    }
    throw new Error('响应中缺少图片数据(b64_json/url)');
  } finally {
    clearTimeout(timer);
  }
}

/** 按 Buffer 魔数嗅探真实图片格式: FFD8FF=JPEG, 89504E47=PNG, 其他默认 .png。 */
function sniffImageExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return '.png';
  }
  return '.png';
}

/**
 * 将生成结果写入 generated/<batchId>/<folder>/<n><ext>, 并发安全地分配序号。
 * 扩展名按内容魔数嗅探(豆包实际返回 JPEG); 序号对已有文件(无论扩展名)取 max+1,
 * 避免 1.png 与 2.jpg 混排时编号冲突。
 * @returns {Promise<string>} 实际保存的文件名(含真实扩展名)
 */
async function saveGenerated(batchId, folder, buf) {
  const dir = path.join(GENERATED_DIR, batchId, folder);
  await fsp.mkdir(dir, { recursive: true });
  const ext = sniffImageExt(buf);
  const existing = await fsp.readdir(dir);
  let n = 1;
  for (const f of existing) {
    const m = /^(\d+)\.(?:png|jpe?g|webp)$/i.exec(f);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  for (;;) {
    const fileName = `${n}${ext}`;
    const filePath = path.join(dir, fileName);
    try {
      const handle = await fsp.open(filePath, 'wx');
      await handle.writeFile(buf);
      await handle.close();
      return fileName;
    } catch (err) {
      if (err.code === 'EEXIST') {
        n += 1;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 任务队列(内存态, 全局并发上限)
// ---------------------------------------------------------------------------

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // 终态任务保留 1 小时后清理, 防内存泄漏

/** 任务进入终态后启动 TTL 定时清理(unref 不阻止进程退出)。 */
function scheduleJobCleanup(job) {
  setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
}

const semaphore = {
  running: 0,
  waiters: [],
};

function acquireSlot() {
  return new Promise((resolve) => {
    if (semaphore.running < maxConcurrency()) {
      semaphore.running += 1;
      resolve();
    } else {
      semaphore.waiters.push(resolve);
    }
  });
}

function releaseSlot() {
  semaphore.running -= 1;
  const next = semaphore.waiters.shift();
  if (next) {
    semaphore.running += 1;
    next();
  }
}

/** 调大并发后立即消化阻塞队列: 把空余并发额度批量放行给等待中的生成项。 */
function pumpWaiters() {
  while (semaphore.running < maxConcurrency() && semaphore.waiters.length > 0) {
    semaphore.running += 1;
    const next = semaphore.waiters.shift();
    next();
  }
}

/**
 * 创建生图任务并异步执行。
 * @param {string} batchId 批次 ID
 * @param {string} prompt 提示词
 * @param {Array<{original: string, folder?: string}>} originals 待生成原图(含重复, 一个元素=一张图)
 */
function createJob(batchId, prompt, originals) {
  const id = crypto.randomUUID();
  const job = {
    id,
    batchId,
    total: originals.length,
    done: 0,
    ok: 0,
    failed: 0,
    status: 'running', // running | done
    errorMessage: null,
    createdAt: Date.now(),
    items: originals.map((o, idx) => ({
      key: idx,
      original: o.original,
      folder: o.folder || null, // listBatch 解析出的结果文件夹, 前端据此保序占位渲染
      status: 'pending', // pending | running | ok | error
      error: null,
      file: null,
    })),
  };
  jobs.set(id, job);

  const items = job.items;
  const worker = async () => {
    for (const item of items) {
      if (item.status !== 'pending') continue;
      item.status = 'running';
      await acquireSlot();
      try {
        const originalAbs = path.join(UPLOADS_DIR, batchId, item.original);
        const buf = await callImageModel(originalAbs, prompt);
        const folder = stripExt(item.original) || 'img';
        // 与 listBatch 的文件夹映射保持一致(处理重名 stem)
        const realFolder = await resolveFolder(batchId, item.original);
        const saved = await saveGenerated(batchId, realFolder || folder, buf);
        item.file = `${realFolder || folder}/${saved}`;
        item.status = 'ok';
        job.ok += 1;
      } catch (err) {
        item.status = 'error';
        item.error = String(err?.message || err).slice(0, 300);
        job.failed += 1;
      } finally {
        job.done += 1;
        releaseSlot();
      }
    }
  };

  const workerCount = Math.min(maxConcurrency(), items.length);
  Promise.all(Array.from({ length: workerCount }, worker))
    .then(() => {
      job.status = 'done';
      scheduleJobCleanup(job);
    })
    .catch((err) => {
      job.status = 'done';
      job.errorMessage = String(err?.message || err);
      scheduleJobCleanup(job);
      // eslint-disable-next-line no-console
      console.error('[job] unexpected error:', err);
    });

  return job;
}

/**
 * 与 listBatch 规则一致地把原图名映射到结果文件夹(处理同 stem 重名)。
 */
async function resolveFolder(batchId, originalName) {
  const dir = path.join(UPLOADS_DIR, batchId);
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const originals = files.filter(isImageFile).sort(naturalSort);
  const used = new Set();
  for (const name of originals) {
    let folder = stripExt(name) || 'img';
    let unique = folder;
    let i = 2;
    while (used.has(unique)) unique = `${folder}-${i++}`;
    if (name === originalName) return unique;
    used.add(unique);
  }
  return null;
}

/** batchId 只允许安全字符, 防路径穿越。 */
function isValidBatchId(batchId) {
  return typeof batchId === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(batchId);
}

function publicJob(job) {
  if (!job) return null;
  const progress = job.total === 0 ? 100 : Math.round((job.done / job.total) * 100);
  return {
    id: job.id,
    batchId: job.batchId,
    total: job.total,
    done: job.done,
    ok: job.ok,
    failed: job.failed,
    progress,
    status: job.status,
    errorMessage: job.errorMessage,
    items: job.items.map((it) => ({
      key: it.key,
      original: it.original,
      folder: it.folder,
      status: it.status,
      error: it.error,
      file: it.file,
    })),
  };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/generated', express.static(GENERATED_DIR));
app.use('/templates', express.static(TEMPLATES_DIR));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024, files: 60 },
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/** 当前默认提示词, 供前端高级设置预填。 */
app.get('/api/config', (_req, res) => {
  res.json({ defaultPrompt: DEFAULT_PROMPT, model: settings.model });
});

// ---------------------------------------------------------------------------
// 设置页 API
// ---------------------------------------------------------------------------

/** 读取设置(apiKey 只回打码值)。 */
app.get('/api/settings', (_req, res) => {
  res.json({
    model: settings.model,
    baseUrl: settings.baseUrl,
    size: settings.size,
    concurrency: settings.concurrency,
    apiKeyMasked: maskApiKey(settings.apiKey),
    hasApiKey: Boolean(settings.apiKey),
    source: fs.existsSync(SETTINGS_FILE) ? 'custom' : 'env',
  });
});

/** 保存设置(落盘, 立即生效)。apiKey 留空表示不修改。 */
app.put('/api/settings', (req, res) => {
  try {
    const b = req.body || {};
    const model = String(b.model || '').trim().slice(0, 120);
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    const size = normSize(b.size);
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    const concurrency = Number(b.concurrency);

    if (!model) return res.status(400).json({ error: '模型 ID 不能为空' });
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: '接口地址必须是 http(s):// 开头的 URL' });
    if (!ALLOWED_SIZES.has(size)) return res.status(400).json({ error: '分辨率仅支持 720p / 1K / 2K / 4K' });
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > CONCURRENCY_LIMIT) {
      return res.status(400).json({ error: `并发生成数量必须是 1~${CONCURRENCY_LIMIT} 的整数` });
    }

    settings.model = model;
    settings.baseUrl = baseUrl;
    settings.size = size;
    settings.concurrency = concurrency;
    if (apiKey) settings.apiKey = apiKey;
    persistSettings();
    // 调大并发后立即放行阻塞队列中等待的生成项
    pumpWaiters();
    res.json({ ok: true, apiKeyMasked: maskApiKey(settings.apiKey), source: 'custom', concurrency: settings.concurrency });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 恢复 .env 默认设置(删除自定义配置)。 */
app.delete('/api/settings', (_req, res) => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
    settings = { ...ENV_SETTINGS };
    res.json({ ok: true, apiKeyMasked: maskApiKey(settings.apiKey), source: 'env' });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 测试连接: 用当前设置(或表单未保存的值)做一次真实 1K 文生图, 验证全链路。 */
app.post('/api/settings/test', async (req, res) => {
  const cfg = {
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
  };
  try {
    const ov = req.body || {};
    if (typeof ov.model === 'string' && ov.model.trim()) cfg.model = ov.model.trim();
    if (typeof ov.baseUrl === 'string' && /^https?:\/\//i.test(ov.baseUrl.trim())) {
      cfg.baseUrl = ov.baseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof ov.apiKey === 'string' && ov.apiKey.trim()) cfg.apiKey = ov.apiKey.trim();
    if (!cfg.apiKey) return res.json({ ok: false, error: '未配置 API Key' });

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('测试请求超时(150s)')), 150_000);
    try {
      const resp = await fetch(`${cfg.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          prompt: '一朵红色牡丹花，喜庆风格',
          size: '1K',
          watermark: false,
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        return res.json({ ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` });
      }
      const json = JSON.parse(text);
      const item = json.data?.[0];
      if (item?.b64_json || item?.url) {
        return res.json({
          ok: true,
          model: cfg.model,
          elapsedMs: Date.now() - started,
          note: '已返回图片数据，配置可用',
        });
      }
      return res.json({ ok: false, error: '响应中缺少图片数据(b64_json/url)' });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    res.json({ ok: false, error: String(err?.message || err).slice(0, 300) });
  }
});

/** 查看当前模板。 */
app.get('/api/template', (_req, res) => {
  try {
    res.json(getTemplateInfo());
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 上传/切换模板(单张图片)。 */
app.post('/api/template', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择模板图片' });
    const originalName = sanitizeName(fixUploadedName(req.file.originalname));
    if (!isImageFile(originalName)) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: '模板必须是图片文件' });
    }
    // 清理旧的 current-template.*
    for (const f of fs.readdirSync(TEMPLATES_DIR)) {
      if (f.startsWith('current-template.')) {
        await fsp.unlink(path.join(TEMPLATES_DIR, f)).catch(() => {});
      }
    }
    const ext = path.extname(originalName).toLowerCase();
    const dest = path.join(TEMPLATES_DIR, `current-template${ext}`);
    await fsp.rename(req.file.path, dest);
    res.json(getTemplateInfo());
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 批量上传原始截图(多图 或 单个 zip)。 */
app.post('/api/originals', upload.array('files', 60), async (req, res) => {
  const tmpFiles = req.files || [];
  try {
    if (tmpFiles.length === 0) return res.status(400).json({ error: '未收到文件' });

    const batchId = `b${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const batchDir = path.join(UPLOADS_DIR, batchId);
    await fsp.mkdir(batchDir, { recursive: true });

    const savedNames = [];
    const putImage = async (name, dataOrPath, isPath) => {
      const clean = sanitizeName(name);
      if (!isImageFile(clean)) return;
      const unique = await uniqueNameIn(batchDir, clean);
      const dest = path.join(batchDir, unique);
      if (isPath) await fsp.rename(dataOrPath, dest);
      else await fsp.writeFile(dest, dataOrPath);
      savedNames.push(unique);
    };

    for (const f of tmpFiles) {
      const displayName = sanitizeName(fixUploadedName(f.originalname));
      if (displayName.toLowerCase().endsWith('.zip')) {
        // 解压 zip, 只取图片, 忽略 __MACOSX / .DS_Store / . 前缀
        const zip = new AdmZip(f.path);
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const entryName = entry.entryName;
          const baseName = path.basename(entryName);
          if (
            entryName.includes('__MACOSX') ||
            baseName.startsWith('.') ||
            baseName === ''
          ) {
            continue;
          }
          await putImage(baseName, entry.getData(), false);
        }
        await fsp.unlink(f.path).catch(() => {});
      } else if (isImageFile(displayName)) {
        await putImage(displayName, f.path, true);
      } else {
        await fsp.unlink(f.path).catch(() => {});
      }
    }

    if (savedNames.length === 0) {
      await fsp.rm(batchDir, { recursive: true, force: true }).catch(() => {});
      return res.status(400).json({ error: '文件中没有可用图片' });
    }

    // 初始化批次元数据(默认名称可后续自定义修改)
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    await writeBatchMeta(batchId, {
      name: `批次 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      createdAt: now.getTime(),
    });

    const batch = await listBatch(batchId);
    res.json(batch);
  } catch (err) {
    for (const f of tmpFiles) await fsp.unlink(f.path).catch(() => {});
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 归档列表: 全部批次(按时间倒序)。 */
app.get('/api/batches', async (_req, res) => {
  try {
    res.json({ batches: await listBatches() });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 查询批次(原图 + 已生成图分组)。 */
app.get('/api/batches/:batchId', async (req, res) => {
  if (!isValidBatchId(req.params.batchId)) return res.status(400).json({ error: '非法批次 ID' });
  const batch = await listBatch(req.params.batchId);
  if (!batch) return res.status(404).json({ error: '批次不存在' });
  res.json(batch);
});

/** 重命名批次(自定义归档名称)。 */
app.put('/api/batches/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!isValidBatchId(batchId)) return res.status(400).json({ error: '非法批次 ID' });
    if (!fs.existsSync(path.join(UPLOADS_DIR, batchId))) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const name = String(req.body?.name || '').trim().slice(0, 50);
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    const existing = await readBatchMeta(batchId);
    const meta = await writeBatchMeta(batchId, {
      name,
      createdAt: existing.createdAt || Date.now(),
    });
    res.json({ batchId, name: meta.name });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 删除整个归档批次: uploads 与 generated 下的批次目录一并物理删除。 */
app.delete('/api/batches/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!isValidBatchId(batchId)) return res.status(400).json({ error: '非法批次 ID' });
    let existed = false;
    for (const dir of [path.join(UPLOADS_DIR, batchId), path.join(GENERATED_DIR, batchId)]) {
      if (fs.existsSync(dir)) {
        await fsp.rm(dir, { recursive: true, force: true });
        existed = true;
      }
    }
    if (!existed) return res.status(404).json({ error: '批次不存在' });
    res.json({ ok: true, deleted: batchId });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 删除批次内某一张原图: 原图文件 + 其对应的生成图文件夹级联删除。 */
app.delete('/api/batches/:batchId/originals', async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!isValidBatchId(batchId)) return res.status(400).json({ error: '非法批次 ID' });
    const name = String(req.body?.name || '');
    if (!name) return res.status(400).json({ error: '缺少原图名称' });
    const dir = path.join(UPLOADS_DIR, batchId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: '批次不存在' });
    // 安全: name 必须是该目录下的真实图片文件名(不信任客户端传入路径)
    const files = (await fsp.readdir(dir)).filter(isImageFile);
    if (!files.includes(name)) return res.status(404).json({ error: '原图不存在' });
    // 先解析生成图文件夹映射(按删除前的原图列表), 再删文件
    const folder = await resolveFolder(batchId, name);
    await fsp.unlink(path.join(dir, name));
    let cascade = false;
    if (folder) {
      const gdir = path.join(GENERATED_DIR, batchId, folder);
      if (fs.existsSync(gdir)) {
        await fsp.rm(gdir, { recursive: true, force: true });
        cascade = true;
      }
    }
    res.json({ ok: true, deleted: name, cascadeDeleted: cascade, folder: folder || null });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 删除批次内某一张已生成图片(带路径穿越防护)。 */
app.delete('/api/batches/:batchId/files', async (req, res) => {  try {
    const { batchId } = req.params;
    if (!isValidBatchId(batchId)) return res.status(400).json({ error: '非法批次 ID' });
    const rel = String(req.body?.file || '').replace(/\\/g, '/');
    if (!rel) return res.status(400).json({ error: '缺少文件参数' });
    const base = path.resolve(GENERATED_DIR, batchId);
    const abs = path.resolve(base, rel);
    if (!abs.startsWith(base + path.sep)) return res.status(400).json({ error: '非法文件路径' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }
    await fsp.unlink(abs);
    res.json({ ok: true, deleted: rel });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 对整个批次触发生成: 每张原图 count 张。 */
app.post('/api/generate', async (req, res) => {
  try {
    const { batchId, prompt } = req.body || {};
    if (!isValidBatchId(batchId)) return res.status(400).json({ error: '非法批次 ID' });
    const count = Math.max(1, Math.min(10, Number(req.body?.count) || 4));
    const batch = await listBatch(batchId);
    if (!batch || batch.originals.length === 0) {
      return res.status(404).json({ error: '批次不存在或无原图' });
    }
    const todo = [];
    for (const o of batch.originals) {
      for (let i = 0; i < count; i += 1) todo.push({ original: o.name, folder: o.folder });
    }
    const job = createJob(batchId, prompt || DEFAULT_PROMPT, todo);
    res.json({ jobId: job.id, total: job.total });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 对某一张原图追加生成 count 张。 */
app.post('/api/batches/:batchId/more', async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!isValidBatchId(batchId)) return res.status(400).json({ error: '非法批次 ID' });
    const { original, prompt } = req.body || {};
    const count = Math.max(1, Math.min(10, Number(req.body?.count) || 1));
    const batch = await listBatch(batchId);
    if (!batch) return res.status(404).json({ error: '批次不存在' });
    const target = batch.originals.find((o) => o.name === original);
    if (!target) return res.status(404).json({ error: '原图不存在' });
    const todo = Array.from({ length: count }, () => ({ original: target.name, folder: target.folder }));
    const job = createJob(batchId, prompt || DEFAULT_PROMPT, todo);
    res.json({ jobId: job.id, total: job.total });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** 轮询任务进度。 */
app.get('/api/jobs/:jobId', (req, res) => {
  const job = publicJob(jobs.get(req.params.jobId));
  if (!job) return res.status(404).json({ error: '任务不存在(服务重启后任务不保留)' });
  res.json(job);
});

/** 打包下载勾选的生成图。 */
app.post('/api/download', async (req, res) => {
  try {
    const { batchId, files } = req.body || {};
    if (!isValidBatchId(batchId) || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '参数错误' });
    }
    const base = path.resolve(GENERATED_DIR, batchId);
    const entries = [];
    for (const raw of files.slice(0, 500)) {
      const rel = String(raw).replace(/\\/g, '/');
      const abs = path.resolve(base, rel);
      if (!abs.startsWith(base + path.sep)) continue; // 防路径穿越
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        entries.push({ abs, name: rel.replaceAll('/', '__') });
      }
    }
    if (entries.length === 0) return res.status(404).json({ error: '没有可下载的文件' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="xibao-${encodeURIComponent(batchId)}.zip"`,
    );
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[zip] error:', err);
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);
    for (const e of entries) archive.file(e.abs, { name: e.name });
    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`红白喜报生成工具已启动: http://localhost:${PORT}`);
});
