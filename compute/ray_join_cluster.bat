@echo off
:: Ray Worker Join Script — Run on Uranus or Razer to join the cluster
:: Requires: Ray 2.54.1 installed (pip install ray==2.54.1)
:: Head: Jupiter at 192.168.0.108:6379

set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1
set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor

echo Stopping any existing Ray processes...
python -m ray.scripts.scripts stop --force 2>nul

echo.
echo Joining Ray cluster at 192.168.0.108:6379...
python -m ray.scripts.scripts start --address=192.168.0.108:6379 --num-gpus=1

if %errorlevel% neq 0 (
    echo.
    echo FAILED to join cluster. Possible causes:
    echo   1. Cannot reach Jupiter at 192.168.0.108 - check network/Tailscale
    echo   2. Ray version mismatch - run: pip install ray==2.54.1
    echo   3. Python version mismatch - need Python 3.11.x
    echo.
    echo Testing connectivity...
    ping -n 1 192.168.0.108
)

echo.
pause
