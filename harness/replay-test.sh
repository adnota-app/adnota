#!/bin/bash
# Interactive replayer: lists available tests, runs whichever you pick.
# Empty input runs the full suite.

set -e
cd "$(dirname "$0")"

# List fixtures with both ops.json and outcomes.json (fully pinned tests).
ready=()
pending=()
for d in fixtures/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  if [ -f "$d/ops.json" ] && [ -f "$d/outcomes.json" ]; then
    ready+=("$name")
  elif [ -f "$d/ops.json" ]; then
    pending+=("$name")
  fi
done

if [ ${#ready[@]} -eq 0 ] && [ ${#pending[@]} -eq 0 ]; then
  echo "No tests found. Record one with: ./record-test.sh"
  exit 1
fi

echo "Tests available:"
for name in "${ready[@]}"; do
  echo "  ✓ $name"
done
for name in "${pending[@]}"; do
  echo "  ✗ $name (no outcomes.json — needs capture)"
done
echo

read -p "Test name (Enter for full suite): " test_name

if [ -z "$test_name" ]; then
  echo
  echo "→ Running full suite ..."
  node scripts/replay.js
else
  test_name=$(echo "$test_name" | tr ' ' '-' | tr -cd 'A-Za-z0-9_-')
  echo
  echo "→ Replaying $test_name ..."
  node scripts/replay.js --site="$test_name"
fi
