#!/bin/bash
# Quick reconnaissance scan script
# Usage: quick-scan.sh <target>

TARGET=$1

if [ -z "$TARGET" ]; then
    echo "Usage: quick-scan.sh <target>"
    exit 1
fi

echo "========================================"
echo "Quick Reconnaissance Scan"
echo "Target: $TARGET"
echo "Time: $(date)"
echo "========================================"

OUTPUT_DIR="/output/$(echo $TARGET | tr '/' '_')_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo ""
echo "[1/5] DNS Lookup..."
dig +short $TARGET > "$OUTPUT_DIR/dns.txt" 2>&1
cat "$OUTPUT_DIR/dns.txt"

echo ""
echo "[2/5] WHOIS..."
whois $TARGET 2>/dev/null | head -30 > "$OUTPUT_DIR/whois.txt"
echo "Saved to $OUTPUT_DIR/whois.txt"

echo ""
echo "[3/5] Quick Port Scan (top 100 ports)..."
nmap -F -T4 $TARGET -oN "$OUTPUT_DIR/nmap_quick.txt" 2>&1
cat "$OUTPUT_DIR/nmap_quick.txt" | grep -E "^[0-9]+/"

echo ""
echo "[4/5] Web Server Detection..."
if curl -s -o /dev/null -w "%{http_code}" "http://$TARGET" 2>/dev/null | grep -q "200\|301\|302"; then
    echo "HTTP detected on port 80"
    whatweb -q "http://$TARGET" 2>/dev/null | tee "$OUTPUT_DIR/whatweb.txt"
fi

if curl -s -o /dev/null -w "%{http_code}" "https://$TARGET" 2>/dev/null | grep -q "200\|301\|302"; then
    echo "HTTPS detected on port 443"
    whatweb -q "https://$TARGET" 2>/dev/null | tee -a "$OUTPUT_DIR/whatweb.txt"
fi

echo ""
echo "[5/5] Summary..."
echo "========================================"
echo "Results saved to: $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"
echo "========================================"
