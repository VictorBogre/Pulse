# Starts the dashboard. Settings come from .env (see .env.example) or the current PowerShell window.
Set-Location $PSScriptRoot
python -m uvicorn app:app --reload --no-access-log
