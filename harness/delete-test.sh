#!/bin/bash
# Interactive deleter: lists existing tests, removes the fixture dir AND
# the sites.json entry in one step.

set -e
cd "$(dirname "$0")"

# List fixtures
ready=()
pending=()
for d in fixtures/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  if [ -f "$d/ops.json" ] && [ -f "$d/outcomes.json" ]; then
    ready+=("$name")
  elif [ -f "$d/ops.json" ] || [ -f "$d/page.html" ]; then
    pending+=("$name")
  fi
done

if [ ${#ready[@]} -eq 0 ] && [ ${#pending[@]} -eq 0 ]; then
  echo "No tests to delete."
  exit 0
fi

echo "Tests:"
for name in "${ready[@]}"; do echo "  ✓ $name"; done
for name in "${pending[@]}"; do echo "  ✗ $name (partial)"; done
echo

read -p "Test to delete: " test_name
if [ -z "$test_name" ]; then
  echo "Aborted."
  exit 0
fi

test_name=$(echo "$test_name" | tr ' ' '-' | tr -cd 'A-Za-z0-9_-')

if [ ! -d "fixtures/$test_name" ]; then
  echo "No fixture directory: fixtures/$test_name"
  exit 1
fi

echo
echo "About to delete:"
ls "fixtures/$test_name" | sed 's/^/  /'
echo "And remove '$test_name' from sites.json."
echo
read -p "Confirm? [y/N]: " ok
if [ "$ok" != "y" ] && [ "$ok" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

rm -rf "fixtures/$test_name"

# Remove the entry from sites.json. test_name is already sanitized above
# (alphanumeric + dash + underscore only), so it's safe to interpolate.
node -e "
const fs = require('fs');
const p = 'sites.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const before = s.sites.length;
s.sites = s.sites.filter(x => x.id !== '$test_name');
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
if (before === s.sites.length) {
  console.log('  (no entry in sites.json — was already absent)');
}
"

echo "✓ Deleted $test_name."
