#!/bin/bash
cd /c/Users/Footb/Documents/Github/teleclaude-main
taskkill //F //IM node.exe 2>/dev/null
sleep 2
start //B node watchdog.js &
echo "Watchdog started"
