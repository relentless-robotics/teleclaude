@echo off
python C:/Users/claude/Lvl3Quant/alpha_discovery/deep_models/feature_ablation_razer.py --mode groups --days 30 --test-folds 5 --epochs 5 --subsample 5 --batch-size 512 > C:/Users/claude/ablation_stdout.log 2>&1
