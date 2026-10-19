#!/usr/bin/env bash
# Same as update.sh (kept so either name works).
exec "$(cd "$(dirname "$0")" && pwd)/update.sh" "$@"
