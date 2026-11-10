# Gate for this repo. Usage: scripts/workflow/checks.ps1 [-Report <path>]
# Local mode (no -Report) only prints. The logic lives in checks.mjs, shared with checks.sh.
param([string]$Report)
Set-Location (git rev-parse --show-toplevel)
if ($Report) { node scripts/workflow/checks.mjs --report $Report } else { node scripts/workflow/checks.mjs }
exit $LASTEXITCODE
