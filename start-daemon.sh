#!/bin/bash
# Double-fork daemon to fully detach from parent
cd /home/farmspace/teleclaude
(
  # First fork
  (
    # Second fork - this process will be orphaned to init
    exec nohup node index.js >> teleclaude-daemon.log 2>&1
  ) &
) &
# Parent exits immediately
exit 0
