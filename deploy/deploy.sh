#!/usr/bin/env bash
# 红白喜报生成工具 - Ubuntu 服务器部署脚本
# 用法: chmod +x deploy/deploy.sh && ./deploy/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> 1. 检查 Node.js (需要 >= 20, 推荐 22)"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 node, 正在通过 nodesource 安装 Node 22 ..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> 2. 安装依赖"
npm install --omit=dev

echo "==> 3. 检查 .env 配置"
if [ ! -f .env ]; then
  echo "缺少 .env, 请参照 README 创建 (PORT/API_KEY/BASE_URL/MODEL/DEFAULT_PROMPT)" >&2
  exit 1
fi

echo "==> 4. 选择进程管理方式"
# 方式 A: pm2 (推荐, 简单)
if command -v pm2 >/dev/null 2>&1; then
  echo "检测到 pm2, 使用 pm2 启动/重启"
  pm2 delete hongbai-xibao 2>/dev/null || true
  pm2 start server/index.js --name hongbai-xibao
  pm2 save
  echo "完成: pm2 logs hongbai-xibao 查看日志"
else
  echo "未检测到 pm2, 可选择:"
  echo "  A. npm install -g pm2 后重跑本脚本"
  echo "  B. 使用 systemd (下方已生成服务单元示例, 取消注释并按需修改后执行)"
  # ---- systemd 示例 (手动启用) ----
  # sudo tee /etc/systemd/system/hongbai-xibao.service > /dev/null <<EOF
  # [Unit]
  # Description=HongBai XiBao Tool
  # After=network.target
  #
  # [Service]
  # Type=simple
  # WorkingDirectory=$APP_DIR
  # ExecStart=$(command -v node) server/index.js
  # Restart=always
  # RestartSec=5
  # Environment=NODE_ENV=production
  #
  # [Install]
  # WantedBy=multi-user.target
  # EOF
  # sudo systemctl daemon-reload
  # sudo systemctl enable --now hongbai-xibao
  # sudo systemctl status hongbai-xibao
fi

echo "==> 部署完成。默认端口见 .env 中 PORT (默认 3400)"
echo "    服务器请放行端口: sudo ufw allow 3400/tcp (可选)"
