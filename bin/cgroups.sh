#!/usr/bin/env bash
# Enable the Raspberry Pi memory cgroup controller when disabled in DTB bootargs.
# Target: Raspberry Pi 4, Debian/Raspberry Pi OS with /boot/firmware.
set -Eeuo pipefail

BOOT_DIR=/boot/firmware
CONFIG="$BOOT_DIR/config.txt"
ORIGINAL="$BOOT_DIR/bcm2711-rpi-4-b.dtb"
PATCHED="$BOOT_DIR/bcm2711-rpi-4-b-iotistica.dtb"
MARKER='# iotistica-memory-cgroups'

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die 'Run with sudo.'
[[ -r /proc/device-tree/model ]] || die 'Not a recognized Raspberry Pi device.'
MODEL=$(tr -d '\0' </proc/device-tree/model)
[[ "$MODEL" == *'Raspberry Pi 4 Model B'* ]] || die "Unsupported model: $MODEL"
[[ -f "$CONFIG" && -f "$ORIGINAL" ]] || die 'Expected Raspberry Pi boot files are missing.'
command -v fdtget >/dev/null || die 'Missing fdtget (install device-tree-compiler).'
command -v fdtput >/dev/null || die 'Missing fdtput (install device-tree-compiler).'
command -v cmp >/dev/null || die 'Missing cmp.'

if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
  say 'Memory cgroups are already enabled. No changes needed.'
  exit 0
fi

# This script specifically addresses the parameter embedded in the stock Pi 4 DTB.
BOOTARGS=$(fdtget -t s "$ORIGINAL" /chosen bootargs) || die 'Cannot read original DTB bootargs.'
if [[ " $BOOTARGS " != *' cgroup_disable=memory '* ]]; then
  die 'Original DTB does not contain cgroup_disable=memory; investigate other boot-argument sources.'
fi

# Do not override an existing custom device-tree selection.
EXISTING=$(sed -nE 's/^[[:space:]]*device_tree[[:space:]]*=[[:space:]]*([^#[:space:]]+).*/\1/p' "$CONFIG" | tail -n 1)
if [[ -n "$EXISTING" && "$EXISTING" != "$(basename "$PATCHED")" ]]; then
  die "Another device_tree is configured ($EXISTING). Refusing to override it."
fi

# Confirm that the disabled controller is actually due to a boot argument.
if ! grep -qw 'cgroup_disable=memory' /proc/cmdline; then
  die 'Memory controller is unavailable, but cgroup_disable=memory is not in the active kernel command line.'
fi

# Do not overwrite a preexisting custom DTB. If present, validate it.
NEWARGS=$(printf '%s\n' "$BOOTARGS" | sed -E 's/(^|[[:space:]])cgroup_disable=memory([[:space:]]|$)/\1/g; s/[[:space:]]+/ /g; s/^ //; s/ $//')
[[ "$NEWARGS" != "$BOOTARGS" ]] || die 'Could not remove boot parameter.'

if [[ -e "$PATCHED" ]]; then
  CURRENT=$(fdtget -t s "$PATCHED" /chosen bootargs) || die 'Existing patched DTB is unreadable.'
  [[ "$CURRENT" == "$NEWARGS" ]] || die 'Existing custom DTB differs from expected bootargs; refusing to overwrite.'
  say 'Existing custom DTB has the expected bootargs.'
else
  TMP=$(mktemp "$BOOT_DIR/.iotistica-dtb.XXXXXX")
  trap 'rm -f "${TMP:-}"' EXIT
  cp "$ORIGINAL" "$TMP"
  fdtput -t s "$TMP" /chosen bootargs "$NEWARGS" || die 'DTB patch failed.'
  [[ "$(fdtget -t s "$TMP" /chosen bootargs)" == "$NEWARGS" ]] || die 'DTB verification failed.'
  chmod 0644 "$TMP"
  mv "$TMP" "$PATCHED"
  trap - EXIT
  say "Created $PATCHED"
fi

# Existing config may already select this DTB (e.g., manual prior setup).
if [[ "$EXISTING" == "$(basename "$PATCHED")" ]]; then
  say 'Boot configuration already selects the custom DTB.'
else
  BACKUP="$CONFIG.bak.$(date +%Y%m%d-%H%M%S)"
  cp -a "$CONFIG" "$BACKUP" || die 'Could not back up config.txt.'
  # Append a final [all] section so the directive applies to Pi 4 regardless
  # of any preceding conditional sections.
  printf '\n[all]\n%s\ndevice_tree=%s\n' "$MARKER" "$(basename "$PATCHED")" >> "$CONFIG"
  say "Backed up configuration: $BACKUP"
  say 'Configured the custom DTB in config.txt.'
fi

sync
say ''
say 'Ready. Reboot manually when you have a recovery path for the boot partition.'
say 'After reboot verify:'
say "  cat /proc/cmdline"
say "  cat /sys/fs/cgroup/cgroup.controllers"
say '  sudo docker stats --no-stream'
