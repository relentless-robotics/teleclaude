#!/bin/bash
# Auto-start all infrastructure when Claude Code launches
# Called by Claude Code hooks on session start

cd "$(dirname "$0")/.."

# Start PM2 processes if not already running
pm2 list --no-color 2>/dev/null | grep -q "qcc-daemon" || pm2 start qcc/ecosystem.config.js --silent 2>/dev/null
pm2 list --no-color 2>/dev/null | grep -q "persistent-monitor" || pm2 start compute/ecosystem.config.js --silent 2>/dev/null

# Ensure MLflow is running
pm2 list --no-color 2>/dev/null | grep -q "mlflow-server" || pm2 start "mlflow server --host 0.0.0.0 --port 5000 --backend-store-uri sqlite:///mlflow/mlflow.db --default-artifact-root mlflow/artifacts" --name mlflow-server --silent 2>/dev/null

# Save state
pm2 save --silent 2>/dev/null

# Verify persistent research queue exists
if [ -f "data/research_queue_persistent.json" ]; then
  echo "Research queue loaded ($(node -e "const q=JSON.parse(require('fs').readFileSync('data/research_queue_persistent.json','utf8')); const exps=q.event_architectures_gpu?.experiments || []; const of=q.orderflow_features_cpu?.experiments || []; console.log(exps.length + of.length)" 2>/dev/null) experiments)"
fi

echo "Infrastructure started"
