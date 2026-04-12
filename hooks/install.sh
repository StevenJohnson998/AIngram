#!/bin/sh
# One-shot hook installer. Run once after cloning.
#
# Configures git to use ./hooks/ as the hooks directory, so pre-commit
# (and any future hook) is picked up automatically.

set -e

cd "$(dirname "$0")/.."

echo "Configuring git to use ./hooks/ for hooks..."
git config core.hooksPath hooks
echo "Done. Installed hooks:"
ls -1 hooks/ | grep -v '\.sh$\|\.md$' | sed 's/^/  - /'

if ! command -v gitleaks >/dev/null 2>&1; then
  echo ""
  echo "WARNING: gitleaks is not installed."
  echo "The pre-commit hook will skip secret scanning."
  echo "Install from: https://github.com/gitleaks/gitleaks/releases"
fi
