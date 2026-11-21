#!/bin/sh
# Fails if stdin carries AI attribution (AGENTS.md hard rule). Used by the commit-msg hook and CI.
if grep -inE 'co-authored-by:.*(claude|anthropic)|generated with[^a-z]*claude|claude\.(ai|com)/(code|share)' >&2; then
  echo "AI attribution found (see AGENTS.md hard rules): remove the lines above." >&2
  exit 1
fi
