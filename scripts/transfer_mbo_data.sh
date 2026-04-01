#!/bin/bash
# Transfer new MBO data to Jupiter and Saturn
# Run this after download completes and unzip finishes
# Usage: bash transfer_mbo_data.sh /path/to/unzipped/GLBX-dir

set -e

SRC_DIR="${1:-/c/Users/Footb/Downloads/GLBX-20260311-Q7PBN4NPTP}"
LOCAL_PERMANENT="/c/Users/Footb/Documents/Github/Lvl3Quant/data/raw/mbo"
JUPITER_HOST="jupiter@192.168.0.108"
JUPITER_DIR="/home/jupiter/Lvl3Quant/data/raw/mbo"
JUPITER_OOT="/home/jupiter/Lvl3Quant/mbo_oot"

echo "=== MBO Data Transfer Script ==="
echo "Source: $SRC_DIR"

# Verify source exists
if [ ! -d "$SRC_DIR" ]; then
    echo "ERROR: Source directory not found: $SRC_DIR"
    echo "Checking if zip needs extracting..."
    ZIP_FILE="${SRC_DIR}.zip"
    if [ -f "$ZIP_FILE" ]; then
        echo "Found zip, extracting..."
        mkdir -p "$SRC_DIR"
        unzip -o "$ZIP_FILE" -d "$SRC_DIR"
    else
        echo "No zip file found either. Exiting."
        exit 1
    fi
fi

# Count source files
SRC_COUNT=$(ls "$SRC_DIR"/*.dbn.zst 2>/dev/null | wc -l)
echo "Source files: $SRC_COUNT .dbn.zst files"

if [ "$SRC_COUNT" -eq 0 ]; then
    # Check subdirectory
    SUBDIR=$(ls -d "$SRC_DIR"/*/ 2>/dev/null | head -1)
    if [ -n "$SUBDIR" ]; then
        echo "Found subdirectory: $SUBDIR"
        SRC_DIR="$SUBDIR"
        SRC_COUNT=$(ls "$SRC_DIR"/*.dbn.zst 2>/dev/null | wc -l)
        echo "Source files (in subdir): $SRC_COUNT .dbn.zst files"
    fi
fi

echo ""
echo "Date range:"
ls "$SRC_DIR"/*.dbn.zst 2>/dev/null | sort | head -1
ls "$SRC_DIR"/*.dbn.zst 2>/dev/null | sort | tail -1

# Step 1: Local permanent copy
echo ""
echo "=== Step 1: Local permanent copy ==="
mkdir -p "$LOCAL_PERMANENT"
echo "Copying to $LOCAL_PERMANENT..."
cp -n "$SRC_DIR"/*.dbn.zst "$LOCAL_PERMANENT/" 2>/dev/null || true
cp -n "$SRC_DIR"/*.json "$LOCAL_PERMANENT/" 2>/dev/null || true
LOCAL_COUNT=$(ls "$LOCAL_PERMANENT"/*.dbn.zst 2>/dev/null | wc -l)
echo "Local permanent: $LOCAL_COUNT files"

# Step 2: Transfer to Jupiter (permanent + OOT dir)
echo ""
echo "=== Step 2: Transfer to Jupiter ==="
ssh $JUPITER_HOST "mkdir -p $JUPITER_DIR $JUPITER_OOT"
echo "SCPing to Jupiter permanent storage..."
scp "$SRC_DIR"/*.dbn.zst "$JUPITER_HOST:$JUPITER_DIR/"
scp "$SRC_DIR"/*.json "$JUPITER_HOST:$JUPITER_DIR/" 2>/dev/null || true
echo "Linking to OOT directory..."
ssh $JUPITER_HOST "for f in $JUPITER_DIR/glbx-mdp3-2025120*.dbn.zst $JUPITER_DIR/glbx-mdp3-202601*.dbn.zst $JUPITER_DIR/glbx-mdp3-202602*.dbn.zst $JUPITER_DIR/glbx-mdp3-202603*.dbn.zst; do [ -f \"\$f\" ] && ln -sf \"\$f\" $JUPITER_OOT/; done"
JUP_COUNT=$(ssh $JUPITER_HOST "ls $JUPITER_DIR/*.dbn.zst 2>/dev/null | wc -l")
OOT_COUNT=$(ssh $JUPITER_HOST "ls $JUPITER_OOT/*.dbn.zst 2>/dev/null | wc -l")
echo "Jupiter permanent: $JUP_COUNT files, OOT linked: $OOT_COUNT files"

# Step 3: Transfer to Saturn via Jupiter
echo ""
echo "=== Step 3: Transfer to Saturn (via Jupiter) ==="
ssh $JUPITER_HOST "ssh saturn@10.0.0.2 'mkdir -p ~/Lvl3Quant/data/raw/mbo'"
ssh $JUPITER_HOST "scp $JUPITER_DIR/*.dbn.zst saturn@10.0.0.2:~/Lvl3Quant/data/raw/mbo/"
ssh $JUPITER_HOST "scp $JUPITER_DIR/*.json saturn@10.0.0.2:~/Lvl3Quant/data/raw/mbo/" 2>/dev/null || true
SAT_COUNT=$(ssh $JUPITER_HOST "ssh saturn@10.0.0.2 'ls ~/Lvl3Quant/data/raw/mbo/*.dbn.zst 2>/dev/null | wc -l'")
echo "Saturn permanent: $SAT_COUNT files"

# Verify
echo ""
echo "=== VERIFICATION ==="
echo "Source:  $SRC_COUNT files"
echo "Local:   $LOCAL_COUNT files"
echo "Jupiter: $JUP_COUNT files (OOT: $OOT_COUNT)"
echo "Saturn:  $SAT_COUNT files"

if [ "$SRC_COUNT" -eq "$JUP_COUNT" ]; then
    echo "OK: Jupiter matches source"
else
    echo "WARNING: Jupiter file count mismatch!"
fi

echo ""
echo "=== TRANSFER COMPLETE ==="
echo "Data permanently stored on all 3 machines."
echo "OOT data symlinked at Jupiter:$JUPITER_OOT"
echo "Ready to launch sweep: cd ~/Lvl3Quant/alpha_discovery && python oot_mega_sweep.py --data-dir $JUPITER_OOT"
