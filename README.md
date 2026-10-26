# 红白喜报生成工具

将微信聊天截图批量加工为 **红白配色喜报营销海报** 的内部工具：输入【原始截图】+【风格参考图】，调用 `doubao-seedream-5.0-pro` 图生图模型批量生成同款风格喜报。

电脑端 + 手机端响应式单页应用，Node.js + Express 单体服务，无数据库。

## 功能

- ① 风格模板：查看 / 替换红白喜报参考图（换模板 = 换风格）
- ② 上传原始截图：多选图片或单个 zip（自动解压、忽略 `__MACOSX` / `.*` 文件）
- ③ 批量生成：每张原图默认 4 张，异步任务 + 进度条轮询，失败可重试
- 结果区：按原图分组、勾选、全选 / 反选、单图追加生成、打包 zip 下载、大图预览
- 高级设置：临时修改生成提示词

## 本地启动

```bash
cd app
npm install
npm start          # 读取 .env 中 PORT，默认 3400
```

浏览器访问 `http://localhost:3400`。

> Windows 下端口被占用时可临时换端口：
> `PORT=3401 npm start`（PowerShell: `$env:PORT=3401; npm start`）

## 服务器部署（Ubuntu）

```bash
cd app
chmod +x deploy/deploy.sh
./deploy/deploy.sh   # 安装依赖并用 pm2 启动（脚本内含 systemd 备选方案）
```

`.env` 配置（**不要提交到 git**，已加入 `.gitignore`）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 3400 |
| `API_KEY` | 模型网关 Key（`Authorization: Bearer <key>`） |
| `BASE_URL` | 模型网关地址，默认 `https://ai.ctaigw.cn/v1` |
| `MODEL` | 模型名，默认 `doubao-seedream-5.0-pro` |
| `DEFAULT_PROMPT` | 默认生成提示词，可在前端高级设置中临时覆盖 |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/template` | 当前模板 URL |
| POST | `/api/template` | 上传/替换模板（multipart 字段 `file`） |
| POST | `/api/originals` | 批量上传原图（multipart 字段 `files`，可多图或单 zip），返回 `{batchId, originals}` |
| POST | `/api/generate` | `{batchId, count=4, prompt?}` 全批次生成，返回 `{jobId}` |
| GET | `/api/jobs/:jobId` | 任务进度（总数/完成/每张状态/失败原因） |
| GET | `/api/batches/:batchId` | 原图分组 + 已生成图列表 |
| POST | `/api/batches/:batchId/more` | `{original, count}` 单图追加生成 |
| POST | `/api/download` | `{batchId, files:[...]}` 打包 zip 下载 |

## 目录结构

```
app/
├── server/index.js        # Express 服务（路由 + 任务队列 + 模型调用）
├── server/templates/      # 风格模板（default-template.png + 用户上传）
├── public/                # 前端单页（原生 HTML/JS/CSS）
├── uploads/<batchId>/     # 原始截图（按批次分目录）
├── generated/<batchId>/<原图名>/<n>.png
├── deploy/deploy.sh       # Ubuntu 部署脚本
└── NOTES.md               # 网关接口实测记录
```

## 说明

- 生图任务保存在内存中，**服务重启后任务进度丢失**（文件仍在磁盘，可通过 `/api/batches/:batchId` 查询）
- 全局生图并发上限 3，单次模型调用超时 180 秒
- 网关实测细节见 [NOTES.md](./NOTES.md)
