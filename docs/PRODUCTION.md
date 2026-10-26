# 生产环境边界

- 项目：红白喜报生成工具
- 端口：3400
- 目录：/home/ubuntu/xibao-tool
- 进程：PM2：xibao-tool

## 推荐检查

`npm install；npm start`

## 不上传、不覆盖

.env、server/settings.json、uploads/ 和 generated/。这些内容只应通过独立的生产备份机制保存，不属于 Git 源码。

本仓库公开可见。任何真实凭据都不应写入代码、Issue、Actions 日志或 Git 历史。
