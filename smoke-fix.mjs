// 修复冒烟验证: 生成 1 张 -> 确认扩展名与魔数一致 -> 确认列表 URL 可访问
import fs from 'node:fs';

const BASE = 'http://localhost:3401';

async function api(url, options) {
  const resp = await fetch(BASE + url, options);
  const json = await resp.json();
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  // 上传原图
  const buf = fs.readFileSync('C:/Users/86188/WorkBuddy/红白图片处理工具/参考素材/27毛贵凤/2.jpg');
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), '2.jpg');
  const batch = await api('/api/originals', { method: 'POST', body: fd });
  console.log('[1] batchId:', batch.batchId);

  const gen = await api('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: batch.batchId, count: 1 }),
  });
  console.log('[2] jobId:', gen.jobId);

  const t0 = Date.now();
  let job;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    job = await api('/api/jobs/' + gen.jobId);
    if (job.status === 'done') break;
    if (Date.now() - t0 > 240000) throw new Error('轮询超时');
  }
  console.log('[3] 生成完成, ok:', job.ok, 'file:', job.items[0].file, '耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's');
  if (job.ok !== 1) throw new Error('生成失败: ' + job.items[0].error);

  // 落盘文件扩展名 + 魔数校验
  const rel = job.items[0].file; // e.g. "2/1.jpg"
  const abs = `generated/${batch.batchId}/${rel}`;
  const fileBuf = fs.readFileSync(abs);
  const ext = rel.split('.').pop().toLowerCase();
  const isJpeg = fileBuf[0] === 0xff && fileBuf[1] === 0xd8 && fileBuf[2] === 0xff;
  const isPng = fileBuf[0] === 0x89 && fileBuf[1] === 0x50 && fileBuf[2] === 0x4e && fileBuf[3] === 0x47;
  console.log(`[4] 落盘: ${abs} (${fileBuf.length} B) ext=.${ext} JFIF魔数=${isJpeg} PNG魔数=${isPng}`);
  if (isJpeg && ext !== 'jpg') throw new Error('内容为 JPEG 但扩展名不是 .jpg');
  if (isPng && ext !== 'png') throw new Error('内容为 PNG 但扩展名不是 .png');

  // 列表接口 URL 可访问性
  const finalBatch = await api('/api/batches/' + batch.batchId);
  const url = finalBatch.originals[0].generated[0].url;
  const imgResp = await fetch(BASE + url);
  const imgBody = Buffer.from(await imgResp.arrayBuffer());
  console.log(`[5] GET ${url} -> HTTP ${imgResp.status}, ${imgResp.headers.get('content-type')}, ${imgBody.length} B`);
  if (!imgResp.ok || imgBody.length !== fileBuf.length) throw new Error('列表 URL 访问异常');

  console.log('SMOKE PASS ✓ batchId =', batch.batchId);
}

main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
