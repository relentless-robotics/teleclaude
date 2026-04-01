Sync MBO event data from Neptune to a remote node. Argument: $ARGUMENTS (target node name)

## Steps

1. **Check source data** on Neptune:
   ```
   Count files in C:/Users/Footb/Documents/Github/Lvl3Quant/data/processed/mbo_events/*.npz
   ```

2. **Check target node data** via SSH (`qcc_ssh_exec`):
   ```
   Count files in <lvl3_root>/data/processed/mbo_events/*.npz
   ```

3. **Identify missing files** — compare file lists
4. **SCP missing files** from Neptune to target using Tailscale IPs:
   - Uranus: nick@100.100.83.37
   - Razer: claude@100.102.215.75
   - Jupiter: jupiter@100.102.174.30

5. **Also sync training scripts** if missing:
   ```
   SCP alpha_discovery/deep_models/train_event_*.py
   ```

6. **Verify** — recount files on target

## Node Paths
| Node | Data Dir |
|------|----------|
| Neptune | C:\Users\Footb\Documents\Github\Lvl3Quant\data\processed\mbo_events |
| Uranus | C:\Users\nick\Lvl3Quant\data\processed\mbo_events |
| Razer | C:\Users\claude\Lvl3Quant\data\processed\mbo_events |
| Jupiter | /home/jupiter/Lvl3Quant/data/processed/mbo_events |
