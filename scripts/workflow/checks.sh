#!/usr/bin/env sh
# Gate for this repo. Usage: scripts/workflow/checks.sh [--report <path>]
# Local mode (no --report) only prints. The logic lives in checks.mjs, shared with checks.ps1.
cd "$(git rev-parse --show-toplevel)" || exit 2
exec node scripts/workflow/checks.mjs "$@"
