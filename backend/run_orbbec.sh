#!/bin/bash
# Wrapper pour les scripts caméra Orbbec — charge les libs SDK v1 depuis le venv
SP="$HOME/hermes-workspace/smart-optica-app/backend/venv/lib/python3.12/site-packages"
export LD_LIBRARY_PATH="$SP${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$HOME/hermes-workspace/smart-optica-app/backend/venv/bin/python3" "$@"
