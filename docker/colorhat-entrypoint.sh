#!/bin/bash
# ColorHat Container Entrypoint
# Logs all commands for audit trail

LOGFILE="/home/colorhat/logs/colorhat_$(date +%Y%m%d_%H%M%S).log"

echo "=== ColorHat Security Container ===" | tee "$LOGFILE"
echo "Started: $(date)" | tee -a "$LOGFILE"
echo "User: $(whoami)" | tee -a "$LOGFILE"
echo "Working Dir: $(pwd)" | tee -a "$LOGFILE"
echo "=================================" | tee -a "$LOGFILE"

# Log all commands if running interactively
if [ -t 0 ]; then
    export PROMPT_COMMAND='echo "$(date +%Y-%m-%d_%H:%M:%S) [CMD] $BASH_COMMAND" >> '"$LOGFILE"
fi

# Execute the command
if [ "$#" -eq 0 ]; then
    exec /bin/bash
else
    echo "Executing: $@" | tee -a "$LOGFILE"
    exec "$@" 2>&1 | tee -a "$LOGFILE"
fi
