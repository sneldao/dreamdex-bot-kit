#!/usr/bin/env bash
# deploy-ec-chime.sh — Deploy the ec-chime house bot to the VPS.
#
# Usage:
#   ./scripts/deploy-ec-chime.sh           # deploy to production
#
# Prerequisites:
#   - SSH access to snel-bot (or replace HOST below)
#   - npm install runs clean locally

set -euo pipefail

HOST="snel-bot"
REMOTE_BASE="/opt/ec-chime"
RELEASE_DIR="${REMOTE_BASE}/releases"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RELEASE="${RELEASE_DIR}/${TIMESTAMP}"

echo "=== ec-chime deploy to ${HOST}:${RELEASE} ==="

# 1. Typecheck
echo "[1/5] Typechecking..."
cd "$(dirname "$0")/.."
npx tsc --noEmit -p strategies/ec-chime/tsconfig.json

# 2. Create release dir on VPS
echo "[2/5] Preparing remote dir..."
ssh "${HOST}" "mkdir -p '${RELEASE}' '${REMOTE_BASE}/logs' '${REMOTE_BASE}/shared'"

# 3. Rsync source (no node_modules — platform-specific binaries must be installed on target)
echo "[3/5] Rsyncing..."
rsync -az --delete \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='node_modules' \
  --exclude='.next' \
  . "${HOST}:${RELEASE}/"

# 4. Install dependencies on VPS (Linux binaries)
echo "[4/5] Installing dependencies on VPS..."
ssh "${HOST}" "cd '${RELEASE}' && npm install 2>&1 | tail -5 && npx tsx --version"

# 5. Update symlink and restart PM2
echo "[5/5] Updating symlink and restarting PM2..."
ssh "${HOST}" bash -s <<EOF
  ln -sfn '${RELEASE}' '${REMOTE_BASE}/current'
  # Symlink shared .env into release
  if [ -f '${REMOTE_BASE}/shared/.env' ]; then
    ln -sf '${REMOTE_BASE}/shared/.env' '${REMOTE_BASE}/current/.env'
  fi
  cd '${REMOTE_BASE}/current'
  pm2 delete ec-chime 2>/dev/null || true
  pm2 start ecosystem.config.cjs
  pm2 save
EOF

echo "Deployed to ${REMOTE_BASE}/current"
echo "Check status: ssh ${HOST} 'pm2 describe ec-chime'"
echo "Check logs:   ssh ${HOST} 'pm2 logs ec-chime --lines 50'"
