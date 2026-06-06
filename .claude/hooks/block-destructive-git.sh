#!/bin/bash
INPUT=$(cat)
BASH_CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ "$BASH_CMD" =~ (git\ push.*--force[^-]|git\ push.*--force$|git\ reset.*--hard|git\ branch.*-D|git\ clean.*-f) ]]; then
  echo "BLOCKED: destructive git command. Use a non-force alternative." >&2
  exit 2
fi
exit 0
