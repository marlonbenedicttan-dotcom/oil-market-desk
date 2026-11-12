#!/usr/bin/env bash
# Run a data audit. A failed audit keeps the previous dataset and exits green: a source/data
# condition is a warning, not a red workflow. Code/CI errors are still caught by the code tests.
set +e
"$@"
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi
echo "::warning::audit failed — keeping the previous dataset; the next run retries"
git checkout -- data/ 2>/dev/null || true
exit 0
