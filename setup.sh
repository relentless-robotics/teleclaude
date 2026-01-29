#!/bin/bash

# TeleClaude API Keys Setup Script
# Creates API_KEYS.md from template if it doesn't exist

if [ ! -f "API_KEYS.md" ]; then
    cp API_KEYS.template.md API_KEYS.md
    echo "Created API_KEYS.md from template."
    echo "Please fill in your API keys in API_KEYS.md"
    echo ""
    echo "The file is gitignored and won't be committed to the repository."
else
    echo "API_KEYS.md already exists."
    echo "Edit it directly to update your API keys."
fi
