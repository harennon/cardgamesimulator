#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" || ! -f "$FILE_PATH" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" =~ \.(ts|vue|js|mjs|json|css|html)$ ]]; then
  npx prettier --write "$FILE_PATH" 2>/dev/null || true
fi
exit 0
