Kill a training job on a node. Argument: $ARGUMENTS (node name)

## Steps

1. **Identify running process** on the node:
   ```
   qcc_ssh_exec: tasklist /fi "imagename eq python.exe" /fo csv /nh
   ```

2. **Confirm what's training** — check MLflow for the node's active run

3. **Kill the process**:
   ```
   qcc_ssh_exec: taskkill /im python.exe /f
   ```

4. **Clean up schtasks** if any:
   ```
   qcc_ssh_exec: schtasks /delete /tn "<TaskName>" /f
   ```

5. **Mark MLflow run as FAILED** if it was logging

6. **Update research queue** — set experiment status back to "queued" if killed early

7. **Report** to #system-status: what was killed, why, what's next

## Safety
- NEVER kill training on Neptune if paper engine is running (check `qcc_health_check` paper_engine status)
- Always confirm with user before killing a run that has 3+ folds complete (might have useful data)
- Save any partial results (.npz predictions) before killing
