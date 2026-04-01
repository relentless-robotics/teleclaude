@echo off
:: Run this as Administrator to open firewall for Ray cluster
:: Right-click -> Run as Administrator

echo Opening Windows Firewall for Ray Cluster...

:: Remove old rules if any
netsh advfirewall firewall delete rule name="Ray Cluster Inbound" >nul 2>&1
netsh advfirewall firewall delete rule name="Ray Cluster ICMP" >nul 2>&1

:: Allow all inbound TCP on Ray ports (GCS, Dashboard, Client, Worker range)
netsh advfirewall firewall add rule name="Ray Cluster Inbound" dir=in action=allow protocol=tcp localport=6379,8265,10001-19999 enable=yes profile=any
if %errorlevel% neq 0 (
    echo ERROR: Failed to add firewall rule. Are you running as Administrator?
    pause
    exit /b 1
)

:: Allow ICMP (ping) for diagnostics
netsh advfirewall firewall add rule name="Ray Cluster ICMP" dir=in action=allow protocol=icmpv4 enable=yes profile=any

:: Also allow outbound (usually open by default but be explicit)
netsh advfirewall firewall add rule name="Ray Cluster Outbound" dir=out action=allow protocol=tcp remoteport=6379,8265,10001-19999 enable=yes profile=any >nul 2>&1

echo.
echo Firewall rules added successfully:
netsh advfirewall firewall show rule name="Ray Cluster Inbound"
echo.
echo Ray cluster ports are now open. You can close this window.
pause
