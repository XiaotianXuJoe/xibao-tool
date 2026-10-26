# 网关接口实测记录（2026-10-19）

## 接口

- `POST https://ai.ctaigw.cn/v1/images/generations`
- Header：`Authorization: Bearer <API_KEY>`、`Content-Type: application/json`

## 实测可用请求体（图生图，已固化到 server/index.js）

```json
{
  "model": "doubao-seedream-5.0-pro",
  "prompt": "参考第2张图的红白喜报海报风格，将第1张微信聊天截图内容加工成同款喜报：...",
  "image": [
    "data:image/jpeg;base64,<第1张=原图>",
    "data:image/png;base64,<第2张=风格参考图>"
  ],
  "size": "2K",
  "watermark": false,
  "response_format": "b64_json"
}
```

要点：

- `image` 为 base64 data URI **数组**，顺序：第 1 张原图、第 2 张参考图（提示词中按此序号引用）。
- `response_format: "b64_json"` 网关**支持**，代码中直接拿 `data[0].b64_json` 落盘；同时保留了 `data[0].url` 的兜底下载逻辑。
- `size` 实测支持 `1K`、`2K`；工具固定用 `2K`。
- `watermark: false` 生效（输出无水印）。
- 原图为 jpg、参考图为 png 的混合输入可用。

## 实测响应格式

```json
{
  "model": "doubao-seedream-5.0-pro",
  "created": 1792416741,
  "data": [ { "b64_json": "<base64 图片数据>" } ]
}
```

## 实测耗时（供容量规划）

| 场景 | size | 耗时 | 输出大小 |
| --- | --- | --- | --- |
| 纯文生图（探测） | 1K | 44.6 s | - |
| 图生图 原图+模板（探测） | 2K | 99.0 s | 586,569 B |
| 图生图 端到端（经本工具） | 2K | 105.3 s | 598,291 B |

> 单张约 100 秒，工具并发上限 3：7 张原图 × 4 张 = 28 张，预计 15~20 分钟。

## 错误形态

- 网关/模型错误返回非 2xx，body 为 JSON 文本；工具截取前 300 字符记入任务失败原因，前端可重试。
- 单次调用超时 180 s 会 abort 并标记该张失败（不阻塞其他任务）。

## 端到端验证（本机，端口 3401）

完整走通：`POST /api/originals`（1.jpg）→ `POST /api/generate`（count=1）→ 轮询 `GET /api/jobs/:jobId` 至 done → 生成 `generated/<batchId>/1/1.png`（598 KB，已人工确认是红白喜报风格）→ `POST /api/download` 返回 zip（565 KB）正常。

验证批次 retained：`generated/bmvfb4pe8299ed0/1/1.png`。复跑脚本：`node verify-e2e.mjs`（需先启动服务）。

## 追加修复记录（QA 回归后，同日）

1. **生成图扩展名按内容嗅探**：网关返回的 `b64_json` 实为 JPEG（魔数 FFD8FF），原先硬编码存 `.png`。现 `saveGenerated` 按魔数嗅探存 `.jpg`/`.png`；序号对目录内已有文件（不限扩展名）取 max+1，避免 `1.png` 与 `2.jpg` 混排冲突。冒烟证据：`generated/bmvfbq1xb76f137/2/1.jpg`（581,075 B，JFIF 魔数，经 `GET /api/batches` URL 访问返回 `image/jpeg` 200）。
2. **任务 TTL**：终态任务 1 小时后从内存 Map 清理（`setTimeout(...).unref()`）。
3. **url 回退下载共用 180s 超时信号**（`fetch(item.url, { signal })`）。

复跑冒烟脚本：`node smoke-fix.mjs`（需先启动服务）。
