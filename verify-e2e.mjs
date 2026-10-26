// 端到端验证脚本: 上传原图 -> 触发生成 -> 轮询 -> 查结果 -> 打包下载
import fs from 'node:fs';

const BASE = 'http://localhost:3401';

async function api(url, options) {
  const resp = await fetch(BASE + url, options);
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/zip')) return { zip: true, resp };
  const json = await resp.json();
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  // 1. 健康检查 + 模板
  console.log('[1] health:', JSON.stringify(await api('/api/health')));
  const tpl = await api('/api/template');
  console.log('[2] template:', tpl.url, 'isDefault:', tpl.isDefault);

  // 3. 上传原图 1.jpg
  const buf = fs.readFileSync('C:/Users/86188/WorkBuddy/红白图片处理工具/参考素材/27毛贵凤/1.jpg');
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), '1.jpg');
  const batch = await api('/api/originals', { method: 'POST', body: fd });
  console.log('[3] batchId:', batch.batchId, 'originals:', batch.originals.map((o) => o.name));

  // 4. 触发生成 1 张
  const gen = await api('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: batch.batchId, count: 1 }),
  });
  console.log('[4] jobId:', gen.jobId, 'total:', gen.total);

  // 5. 轮询
  const t0 = Date.now();
  let job;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    job = await api('/api/jobs/' + gen.jobId);
    console.log(`[5] progress ${job.progress}% done=${job.done}/${job.total} ok=${job.ok} failed=${job.failed}`);
    if (job.status === 'done') break;
    if (Date.now() - t0 > 240000) throw new Error('轮询超时');
  }
  console.log('[5] 单张耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's');
  if (job.ok !== 1) throw new Error('生成失败: ' + JSON.stringify(job.items));

  // 6. 查询批次结果
  const finalBatch = await api('/api/batches/' + batch.batchId);
  const genList = finalBatch.originals[0].generated;
  console.log('[6] generated files:', genList.map((g) => g.file));

  // 确认文件真实存在且非空
  const rel = genList[0].url.replace('/generated/', '');
  const abs = 'generated/' + decodeURIComponent(rel);
  const stat = fs.statSync(abs);
  console.log('[6] 落盘文件:', abs, 'bytes:', stat.size);
  if (stat.size < 10000) throw new Error('生成文件过小, 可能损坏');

  // 7. 打包下载
  const dl = await api('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: batch.batchId, files: genList.map((g) => g.file) }),
  });
  const zipBuf = Buffer.from(await dl.resp.arrayBuffer());
  fs.writeFileSync('verify-download.zip', zipBuf);
  console.log('[7] zip 下载成功:', zipBuf.length, 'bytes ->', '"verify-download.zip"');

  console.log('ALL PASS ✓  batchId =', batch.batchId);
}

main().catch((e) => { console.error('VERIFY FAILED:', e); process.exit(1); });
