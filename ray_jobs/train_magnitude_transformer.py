"""Wrapper: Train transformer to predict MAGNITUDE (|price_change|) instead of signed direction.
This tests the hypothesis that transformer is naturally better at predicting HOW BIG moves are."""
import os, sys, subprocess

# Modify the labels in the dataset: replace labels with abs(labels)
# The cleanest way: monkey-patch the dataset after import

root = None
for r in ['C:/Users/njlia/Lvl3Quant', 'C:/Lvl3Quant']:
    if os.path.isdir(os.path.join(r, 'data/processed/mbo_events')):
        root = r; break

if not root:
    print("ERROR: no data found"); sys.exit(1)

sys.path.insert(0, os.path.join(root, 'alpha_discovery/deep_models'))
import numpy as np

# Monkey-patch: override the dataset to use absolute labels
import train_event_transformer_fast as tf_mod

_orig_load = tf_mod.MboEventDataset._load_data
def _patched_load(self, npz_files):
    _orig_load(self, npz_files)
    # Replace all labels with absolute values
    for h in self.all_labels:
        self.all_labels[h] = [np.abs(l) for l in self.all_labels[h]]
    print(f"[MAGNITUDE] Patched labels to absolute values")

tf_mod.MboEventDataset._load_data = _patched_load
tf_mod.MLFLOW_EXPERIMENT = "Transformer_Magnitude"

# Run training
out_dir = os.path.join(root, 'alpha_discovery/deep_models/results/transformer_magnitude')
os.makedirs(out_dir, exist_ok=True)
data_dir = os.path.join(root, 'data/processed/mbo_events')

sys.argv = ['train_event_transformer_fast.py', '--n-folds', '5', '--skip-transfer', '--device', 'cuda',
            '--data-dir', data_dir, '--output-dir', out_dir]
exec(open(os.path.join(root, 'alpha_discovery/deep_models/train_event_transformer_fast.py')).read())
