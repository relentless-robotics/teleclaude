import sys
sys.path.insert(0, r"C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models")
sys.path.insert(0, r"C:\Users\claude\Lvl3Quant")
try:
    from book_spatial_cnn import BookSpatialCNN, BookTensorDataset
    print("BookSpatialCNN OK")
except Exception as e:
    print(f"BookSpatialCNN FAIL: {e}")
try:
    from feature_engineering import BookFeatureEngineer
    print("BookFeatureEngineer OK")
except Exception as e:
    print(f"BookFeatureEngineer FAIL: {e}")
try:
    import torch
    print(f"PyTorch {torch.__version__}, CUDA={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM free: {torch.cuda.mem_get_info()[0]/1024**3:.1f} GB")
except Exception as e:
    print(f"Torch FAIL: {e}")

from pathlib import Path
npz_dir = Path(r"C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache")
npz_files = sorted(npz_dir.glob("*_book_tensors.npz"))
print(f"NPZ files: {len(npz_files)}")
if npz_files:
    print(f"Date range: {npz_files[0].stem[:10]} to {npz_files[-1].stem[:10]}")

print("ALL CHECKS PASSED")
