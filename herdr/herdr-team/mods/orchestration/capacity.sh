#!/bin/sh
# shortcut: forwarder for sessions started before the move, delete after the next Start team
exec sh "$(dirname "$0")/harness/capacity/capacity.sh" "$@"
