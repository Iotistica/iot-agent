#!/bin/bash
# vim: tabstop=4 shiftwidth=4 softtabstop=4
# -*- sh-basic-offset: 4 -*-

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "update.sh must be run by the root-owned update service" >&2
    exit 1
fi
umask 0022

echo "≡ƒöä Iotistica Agent Update (Systemd Mode)"
echo "========================================"

# Parse arguments
TARGET_VERSION="${1:-latest}"
FORCE="${2:-false}"
LOCK_FILE="${3:-/var/lib/iotistic/agent/update.lock}"
SERVICE_NAME="iotistica-agent"
STATUS_FILE="/var/lib/iotistic/agent/update-status.json"

# Cleanup function to remove lock file and write status on exit
cleanup() {
    local exit_code=$?
    
    # Cleanup temp files
    cd /tmp
    rm -rf iotistic-agent-update agent-update.tar.gz agent-update.tar.gz.sha256
    
    # Remove lock file
    if [ -f "$LOCK_FILE" ]; then
        rm -f "$LOCK_FILE"
        echo "≡ƒöô Update lock removed"
    fi
    
    # Write status file (agent reads this on next boot)
    if [ $exit_code -eq 0 ]; then
        cat > "$STATUS_FILE" <<EOF
{
  "version": "$TARGET_VERSION",
  "success": true,
  "completed_at": $(date +%s)000,
  "deployment_type": "systemd"
}
EOF
        echo "Γ£à Update status written: SUCCESS"
    else
        cat > "$STATUS_FILE" <<EOF
{
  "version": "$TARGET_VERSION",
  "success": false,
  "completed_at": $(date +%s)000,
  "deployment_type": "systemd"
}
EOF
        echo "Update status written: FAILURE"
    fi
    chown iotistic:iotistic "$STATUS_FILE"
    chmod 0644 "$STATUS_FILE"
}

# Register cleanup on script exit (success or failure)
trap cleanup EXIT INT TERM

# Detect architecture for platform-specific tarball
DETECTED_ARCH=$(uname -m)
case "$DETECTED_ARCH" in
    aarch64|arm64)
        TARBALL_SUFFIX="-arm64"
        echo "Detected ARM64 architecture - will download ARM-optimized tarball"
        ;;
    x86_64|amd64)
        TARBALL_SUFFIX="-x86_64"
        echo "Detected x86_64 architecture"
        ;;
    *)
        TARBALL_SUFFIX=""
        echo "Unknown architecture ($DETECTED_ARCH) - using generic tarball"
        ;;
esac

# Get current version from package.json if available
CURRENT_VERSION="unknown"
if [ -f /opt/iotistic/agent/package.json ]; then
    CURRENT_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /opt/iotistic/agent/package.json | sed 's/.*"\([^"]*\)".*/\1/' || echo "unknown")
fi

echo "Current version: $CURRENT_VERSION"
echo "Architecture: $DETECTED_ARCH ($TARBALL_SUFFIX)"

# Determine download URL
if [ "$TARGET_VERSION" = "latest" ]; then
    # Use latest version with architecture suffix
    DOWNLOAD_URL="https://get.iotistica.com/agent/artifacts/agent-latest${TARBALL_SUFFIX}.tar.gz"
    echo "Target version: latest"
else
    # Use specific version with architecture suffix
    DOWNLOAD_URL="https://get.iotistica.com/agent/versions/agent-${TARGET_VERSION}${TARBALL_SUFFIX}.tar.gz"
    echo "Target version: $TARGET_VERSION"
fi

# Check if update needed
if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ] && [ "$FORCE" != "true" ]; then
    echo "Already on target version!"
    exit 0
fi

# Create backup directory
BACKUP_DIR="/var/lib/iotistic/backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Backup current installation
echo ""
echo "Backing up current installation..."
if [ -d /opt/iotistic/agent ]; then
    tar -czf "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" \
        -C /opt/iotistic agent
    echo "Backup saved to $BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz"
fi

# Download new tarball
echo ""
echo "Downloading agent tarball..."
cd /tmp
rm -rf iotistic-agent-update agent-update.tar.gz agent-update.tar.gz.sha256

echo "Downloading from: $DOWNLOAD_URL"
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"

# Try to download with curl or wget
DOWNLOAD_FAILED=0
if command -v curl &> /dev/null; then
    curl -fSL -o agent-update.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
    [ "$DOWNLOAD_FAILED" = "0" ] && curl -fSL -o agent-update.tar.gz.sha256 "$CHECKSUM_URL" || DOWNLOAD_FAILED=1
elif command -v wget &> /dev/null; then
    wget -O agent-update.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
    [ "$DOWNLOAD_FAILED" = "0" ] && wget -O agent-update.tar.gz.sha256 "$CHECKSUM_URL" || DOWNLOAD_FAILED=1
else
    echo "Neither curl nor wget is available"
    exit 1
fi

if [ "$DOWNLOAD_FAILED" = "1" ]; then
    echo ""
    echo "Failed to download agent from distribution server"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check your internet connection"
    echo "  2. Verify the download URL: $DOWNLOAD_URL"
    echo "  3. Verify the agent version exists: $TARGET_VERSION"
    exit 1
fi

# Verify SHA256 checksum
echo "Verifying tarball integrity..."
EXPECTED_HASH=$(awk '{print $1}' agent-update.tar.gz.sha256)
if command -v sha256sum &> /dev/null; then
    ACTUAL_HASH=$(sha256sum agent-update.tar.gz | awk '{print $1}')
elif command -v shasum &> /dev/null; then
    ACTUAL_HASH=$(shasum -a 256 agent-update.tar.gz | awk '{print $1}')
else
    echo "Warning: sha256sum/shasum not available - skipping integrity check"
    ACTUAL_HASH="$EXPECTED_HASH"
fi

if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
    echo "Checksum mismatch - tarball may be corrupted or tampered with"
    echo "  Expected: $EXPECTED_HASH"
    echo "  Actual:   $ACTUAL_HASH"
    exit 1
fi
echo "Checksum verified OK"

# Extract tarball
echo "Extracting agent..."
mkdir -p iotistic-agent-update
tar -xzf agent-update.tar.gz -C iotistic-agent-update || {
    echo "Γ¥î Failed to extract agent tarball"
    exit 1
}

# Verify extraction
if [ ! -f iotistic-agent-update/package.json ]; then
    echo "Tarball extraction failed - package.json not found"
    exit 1
fi

# Extract actual version from downloaded package.json
EXTRACTED_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' iotistic-agent-update/package.json | sed 's/.*"\([^"]*\)".*/\1/' || echo "unknown")
echo "Downloaded version: $EXTRACTED_VERSION"

# Stop agent service
if [ "$TARGET_VERSION" != "latest" ] && [ "$EXTRACTED_VERSION" != "$TARGET_VERSION" ]; then
    echo "Downloaded version does not match the requested version" >&2
    exit 1
fi

echo ""
echo "Stopping agent service..."
systemctl stop "$SERVICE_NAME"

# Replace installation files
echo ""
echo "Installing new version..."

# Clean up existing installation (except config and data)
rm -rf /opt/iotistic/agent/node_modules
rm -rf /opt/iotistic/agent/dist
rm -f /opt/iotistic/agent/package*.json

# Copy new files
cp -r iotistic-agent-update/* /opt/iotistic/agent/ || {
    echo "Failed to copy agent files"
    
    # Attempt rollback
    if [ -f "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" ]; then
        echo "Rolling back to previous version..."
        tar -xzf "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" -C /opt/iotistic
    fi
    
    systemctl start "$SERVICE_NAME"
    exit 1
}

echo "Files installed"

# Start agent service
if [ -f /opt/iotistic/agent/bin/update.sh ]; then
    install -o root -g root -m 0755 /opt/iotistic/agent/bin/update.sh /usr/local/bin/update.sh
fi
if [ -f /opt/iotistic/agent/bin/update-runner.sh ]; then
    install -o root -g root -m 0755 /opt/iotistic/agent/bin/update-runner.sh /usr/local/sbin/update-runner.sh
fi
if [ -f /opt/iotistic/agent/bin/systemd/update.service ] && [ -f /opt/iotistic/agent/bin/systemd/update.path ]; then
    install -o root -g root -m 0644 /opt/iotistic/agent/bin/systemd/update.service /etc/systemd/system/update.service
    install -o root -g root -m 0644 /opt/iotistic/agent/bin/systemd/update.path /etc/systemd/system/update.path
    systemctl daemon-reload
    systemctl enable update.service update.path >/dev/null
    systemctl enable --now update.path >/dev/null
fi

echo ""
echo "Starting agent service..."
systemctl start "$SERVICE_NAME"

# Wait for service to stabilize
echo "Waiting for service to start (15 seconds)..."
sleep 15

# Verify service is running with new version
if systemctl is-active --quiet "$SERVICE_NAME"; then
    # Get updated version from package.json
    NEW_VERSION="unknown"
    if [ -f /opt/iotistic/agent/package.json ]; then
        NEW_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /opt/iotistic/agent/package.json | sed 's/.*"\([^"]*\)".*/\1/' || echo "unknown")
    fi
    
    echo ""
    echo "Agent updated successfully!"
    echo "   Old version: $CURRENT_VERSION"
    echo "   New version: $NEW_VERSION"
    echo ""
    echo "Recent logs:"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager
    
    # Cleanup old backups (keep last 3)
    echo ""
    echo "Cleaning up old backups..."
    find "$BACKUP_DIR" -name "agent-backup-*" -type f | sort -r | tail -n +4 | xargs -r rm -f 2>/dev/null || true
    
    echo ""
    echo "Update complete!"
    
else
    echo "Service failed to start, attempting rollback..."
    
    # Stop failed service
    systemctl stop "$SERVICE_NAME"
    
    # Restore from backup
    if [ -f "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" ]; then
        echo "ΓÅ«∩╕Å  Restoring backup..."
        rm -rf /opt/iotistic/agent
        mkdir -p /opt/iotistic
        tar -xzf "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" -C /opt/iotistic
        
        # Restart service
        systemctl start "$SERVICE_NAME"
        sleep 10
        
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            echo "Rollback complete, agent restored to version $CURRENT_VERSION"
        else
            echo "CRITICAL: Service failed to start after rollback"
            echo "   Manual intervention required: systemctl status $SERVICE_NAME"
        fi
    else
        echo "CRITICAL: No backup found for rollback"
        echo "   Manual intervention required: systemctl status $SERVICE_NAME"
    fi
    
    exit 1
fi
