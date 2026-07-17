#!/bin/bash
# VPS Deployment Script for VaidyaGate Seminar
# Run this script on your VPS to pull the latest changes from GitHub

set -e

APP_DIR="/var/www/vaidyagogate-seminar"  # Change this to your app directory
BRANCH="main"  # Or use "seminar-qual-options-eticket-warning" for testing

echo "===== VaidyaGate Seminar Deployment Script ====="
echo ""

# Navigate to app directory
if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: App directory $APP_DIR not found!"
    echo "Please update APP_DIR in this script to your correct path."
    exit 1
fi

cd "$APP_DIR"

echo "[1/5] Checking git status..."
git status --short

echo ""
echo "[2/5] Fetching latest changes from GitHub..."
git fetch origin

echo ""
echo "[3/5] Checking out $BRANCH branch..."
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo ""
echo "[4/5] Installing dependencies (if package.json changed)..."
if [ -f "package.json" ]; then
    npm install --production 2>/dev/null || npm install 2>/dev/null || echo "npm install skipped (may not be needed)"
fi

echo ""
echo "[5/5] Restarting application..."
# Try different restart methods
if command -v pm2 &> /dev/null; then
    pm2 restart server.js 2>/dev/null || pm2 restart all 2>/dev/null || echo "PM2 restart skipped"
elif [ -f "ecosystem.config.js" ]; then
    pm2 restart ecosystem.config.js 2>/dev/null || echo "PM2 ecosystem not running"
else
    echo "No process manager found. You may need to manually restart the application."
    echo "Try: node server.js &"
fi

echo ""
echo "===== Deployment Complete! ====="
echo "Check your application at: https://your-domain.com"
echo ""
echo "If the app doesn't respond, check logs:"
echo "  - PM2: pm2 logs"
echo "  - Direct: node server.js"
