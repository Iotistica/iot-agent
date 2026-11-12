#!/bin/bash
set -euo pipefail

REQUEST_FILE="/var/lib/iotistic/agent/update.lock"
RUNNING_FILE="${REQUEST_FILE}.running"
UPDATE_SCRIPT="/usr/local/bin/update.sh"
RUN_LOCK_FILE="/run/lock/update-runner.lock"

if [ "$(id -u)" -ne 0 ]; then
    echo "Update runner must execute as root" >&2
    exit 1
fi

exec 9>"$RUN_LOCK_FILE"
if ! flock -n 9; then
    exit 0
fi

if [ -L "$UPDATE_SCRIPT" ] || [ ! -f "$UPDATE_SCRIPT" ] || [ "$(stat -c '%u' "$UPDATE_SCRIPT")" != "0" ] || [ "$(stat -c '%a' "$UPDATE_SCRIPT")" != "755" ]; then
    echo "Update script is missing or has unsafe ownership or permissions" >&2
    exit 1
fi

# A marker left by a killed worker is safe to retry: update.sh validates the
# archive checksum and rolls back if the updated service does not become active.
while [ -e "$RUNNING_FILE" ] || [ -e "$REQUEST_FILE" ]; do
    if [ ! -e "$RUNNING_FILE" ]; then
        mv -- "$REQUEST_FILE" "$RUNNING_FILE" || continue
    fi

    if [ -L "$RUNNING_FILE" ] || [ ! -f "$RUNNING_FILE" ]; then
        echo "Rejecting non-regular update request" >&2
        rm -f -- "$RUNNING_FILE"
        continue
    fi

    mapfile -t request < "$RUNNING_FILE"
    if [ "${#request[@]}" -ne 2 ]; then
        echo "Rejecting malformed update request" >&2
        rm -f -- "$RUNNING_FILE"
        continue
    fi

    target_version="${request[0]}"
    force="${request[1]}"
    if [[ "$target_version" != "latest" && ! "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[[:alnum:]_.]+)?$ ]]; then
        echo "Rejecting invalid update version" >&2
        rm -f -- "$RUNNING_FILE"
        continue
    fi
    if [[ "$force" != "true" && "$force" != "false" ]]; then
        echo "Rejecting invalid update force flag" >&2
        rm -f -- "$RUNNING_FILE"
        continue
    fi

    echo "Starting validated update to $target_version (force=$force)"
    if ! "$UPDATE_SCRIPT" "$target_version" "$force" "$RUNNING_FILE"; then
        echo "Update script failed for $target_version; see journalctl -u update.service" >&2
    fi
    rm -f -- "$RUNNING_FILE"
done