#!/bin/bash
# Interactive recorder: snapshot the page if needed, then record a test.
#
# Run this from the harness/ directory. Prompts for a test name and (on
# first use) a URL. Snapshots the page once, then opens a browser for you
# to perform the workflow. Stop with Alt+Shift+S in the browser.

set -e
cd "$(dirname "$0")"

DEFAULT_URL="https://www.bing.com/"

read -p "Test name (fixture id): " test_name
if [ -z "$test_name" ]; then
  echo "Test name required."
  exit 1
fi

# Strip any spaces; restrict to safe chars.
test_name=$(echo "$test_name" | tr ' ' '-' | tr -cd 'A-Za-z0-9_-')

# If a snapshot already exists, reuse it unless the user wants to refresh.
if [ -f "fixtures/$test_name/page.html" ]; then
  echo
  echo "Snapshot already exists at fixtures/$test_name/page.html"
  read -p "Re-snapshot from a fresh URL? [y/N]: " resnap
  if [ "$resnap" = "y" ] || [ "$resnap" = "Y" ]; then
    read -p "URL [$DEFAULT_URL]: " url
    url="${url:-$DEFAULT_URL}"
    echo
    echo "→ Re-snapshotting $url ..."
    node scripts/snapshot.js --site="$test_name" --url="$url"
  fi
else
  echo
  read -p "URL [$DEFAULT_URL]: " url
  url="${url:-$DEFAULT_URL}"
  echo
  echo "→ Step 1/2: Snapshotting $url so the test runs against a stable copy ..."
  node scripts/snapshot.js --site="$test_name" --url="$url"
fi

# If ops.json already exists, warn before overwriting.
if [ -f "fixtures/$test_name/ops.json" ]; then
  echo
  read -p "ops.json already exists for '$test_name'. Overwrite? [y/N]: " ow
  if [ "$ow" != "y" ] && [ "$ow" != "Y" ]; then
    echo "Aborted. Existing recording preserved."
    exit 0
  fi
  rm -f "fixtures/$test_name/ops.json" "fixtures/$test_name/outcomes.json"
fi

echo
echo "→ Step 2/2: Recording against fixture://$test_name"
echo "  Browser opens. Perform your workflow."
echo "  Stop with Alt+Shift+S in the browser (or Ctrl+C here)."
echo
node scripts/record.js --site="$test_name" --url="fixture://$test_name"

echo
echo "✓ Done. Watch the recording back with:"
echo "    ./replay-test.sh"
