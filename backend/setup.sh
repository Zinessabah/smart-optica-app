#!/bin/bash
cd "$(dirname "$0")/.."
source backend/venv/bin/activate
pip install fastapi uvicorn mediapipe opencv-python-headless python-multipart
echo "=== INSTALL DONE ==="
