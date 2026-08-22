#!/bin/bash
# Simple Pull Script - Run this on your VPS
# This pulls the latest changes from GitHub main branch

APP_DIR="/var/www/vaidyagogate-seminar"  # <-- CHANGE THIS to your app directory

echo "Pulling latest from GitHub..."
cd "$APP_DIR"
git pull origin main

echo "Done! Restart your app if needed."
