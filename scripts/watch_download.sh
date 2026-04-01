#!/bin/bash
PART_FILE="/c/Users/Footb/Downloads/GLBX-20260311-Q7PBN4NPTP.uEgwF0B4.zip.part"
ZIP_FILE="/c/Users/Footb/Downloads/GLBX-20260311-Q7PBN4NPTP.zip"

while true; do
    if [ ! -f "$PART_FILE" ]; then
        ZIP_SIZE=$(stat -c%s "$ZIP_FILE" 2>/dev/null || echo 0)
        if [ "$ZIP_SIZE" -gt 5000000000 ]; then
            echo "DOWNLOAD COMPLETE! Size: $ZIP_SIZE bytes"
            exit 0
        fi
    fi
    PART_SIZE=$(stat -c%s "$PART_FILE" 2>/dev/null || echo 0)
    PART_GB=$((PART_SIZE / 1073741824))
    echo "Downloading... ${PART_GB}GB / ~17GB"
    sleep 120
done
