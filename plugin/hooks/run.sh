#!/bin/sh
# Runs the Bugnet hint hook with Node when it is installed, and stays silent otherwise
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/bugnet-hook.mjs" "$@"
