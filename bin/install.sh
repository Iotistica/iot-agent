#!/bin/bash
set -e

# Iotistica Agent - Unified Installation Script
# Version: AGENT_VERSION_PLACEHOLDER
# This script installs the Iotistic agent using either Docker or Systemd
# Usage: curl -sfL https://get.iotistica.com/agent | sh
#
# The agent installs in standalone mode by default. Open the admin UI to configure
# cloud sync and provision the device — no interactive prompts required.
#
# Environment Variables (optional overrides):
#   IOTISTICA_AGENT_VERSION        - Agent version to install (default: latest)
#   IOTISTICA_DEVICE_PORT          - Device API port (default: 48484)
#   IOTISTICA_API                  - Cloud API endpoint — set to enable cloud mode (e.g., https://api.iotistica.com)
#   PROVISIONING_KEY               - Cloud provisioning key (only used when IOTISTICA_API is set)
#   IOTISTICA_DOWNLOAD_BASE_URL    - Base URL for published agent tarballs (default: https://get.iotistica.com/agent/artifacts)
#   IOTISTICA_INSTALL_SOURCE       - Install source: auto | repo | artifact (default: auto)
#   IOTISTICA_INSTALL_DOCKER       - Set to yes/true/1 to allow automatic Docker installation
#   IOTISTICA_INSTALL_MOSQUITTO    - Set to yes/true/1 to install and manage a local Mosquitto broker
#   MQTT_BROKER_PORT               - Port for the local Mosquitto broker (default: 1883); set if 1883 is already in use
#   INITIAL_ADMIN_PASSWORD          - Admin UI password (default: randomly generated on first start)
#   MQTT_USERNAME                  - MQTT broker username (default: admin; prompted interactively on first install)
#   MQTT_PASSWORD                  - MQTT broker password (default: auto-generated; prompted interactively on first install)
#   AGENT_SHELL_HMAC_KEY           - HMAC secret for remote shell command verification
#   FORCE_INSTALL                  - Legacy opt-in flag; set to 1 to allow automatic Docker installation

# Note: This script is POSIX-compliant and works with both sh and bash
# No re-exec needed - works when piped to sh

SCRIPT_VERSION="AGENT_VERSION_PLACEHOLDER"
BUILD_ID="BUILD_ID_PLACEHOLDER"

echo "--------------------------------------------------------------------------------"
echo "|                                                                              |"
echo "|     ___       _   _     _   _                                               |"
echo "|    |_ _|___  | |_(_)___| |_(_) ___ __ _                                     |"
echo "|     | |/ _ \ | __| / __| __| |/ __/ _\` |                                    |"
echo "|     | | (_) || |_| \__ \ |_| | (_| (_| |                                    |"
echo "|    |___\___/  \__|_|___/\__|_|\___\__,_|                                     |"
echo "|                                                                              |"
echo "|                    Agent Installer v${SCRIPT_VERSION} (${BUILD_ID})"
echo "|                                                                              |"
echo "--------------------------------------------------------------------------------"
echo ""


# Ensure common binary locations are in PATH — sudo sh strips user profile
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# Check if running as root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    OS_VERSION=$VERSION_ID
else
    echo "Error: Cannot detect OS"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        ARCH_NAME="x86_64"
        ;;
    aarch64|arm64)
        ARCH_NAME="arm64"
        ;;
    armv7l|armhf)
        ARCH_NAME="armhf"
        ;;
    *)
        echo "Warning: Unknown architecture $ARCH, continuing anyway..."
        ARCH_NAME="$ARCH"
        ;;
esac

echo "Detected OS: $OS $OS_VERSION ($ARCH_NAME)"

# Systemd service name - single source of truth
SERVICE_NAME="iotistica-agent"

# This installer currently relies on apt-get/dpkg for package setup.
# Detect Debian family explicitly so unsupported distros fail fast with a clear error.
is_debian_family() {
    case "$OS" in
        debian|ubuntu|raspbian)
            return 0
            ;;
    esac

    if [ -n "$ID_LIKE" ] && echo "$ID_LIKE" | grep -qi "debian"; then
        return 0
    fi

    return 1
}

# Helper function to install Docker if needed
install_docker_if_needed() {
    REQUIRE_INSTALL="${1:-no}"  # Internal override only; prefer explicit env var opt-in
    
    if command -v docker >/dev/null 2>&1; then
        echo "✓ Docker is already installed ($(docker --version))"
        return 0
    fi
    
    echo "⚠️  Docker is not installed on this system."
    echo ""
    
    # Determine if we should install.
    # Safety default: do NOT auto-install on non-interactive systems unless explicitly opted in.
    SHOULD_INSTALL="no"
    if [ "$REQUIRE_INSTALL" = "yes" ] || [ "$REQUIRE_INSTALL" = "y" ]; then
        SHOULD_INSTALL="yes"
    fi

    if [ "$IOTISTICA_INSTALL_DOCKER" = "yes" ] || [ "$IOTISTICA_INSTALL_DOCKER" = "true" ] || [ "$IOTISTICA_INSTALL_DOCKER" = "1" ]; then
        SHOULD_INSTALL="yes"
    fi

    if [ "$FORCE_INSTALL" = "1" ]; then
        SHOULD_INSTALL="yes"
    fi

    if [ "$SHOULD_INSTALL" != "yes" ] && [ "$SHOULD_INSTALL" != "y" ] && [ -e /dev/tty ]; then
        echo -n "Would you like to install Docker now? (yes/no): " >/dev/tty
        read SHOULD_INSTALL </dev/tty
    fi
    
    if [ "$SHOULD_INSTALL" = "yes" ] || [ "$SHOULD_INSTALL" = "y" ]; then
        echo "Installing Docker..."
        curl -fsSL https://get.docker.com -o get-docker.sh
        _DOCKER_LOG=$(mktemp)
        if ! sh get-docker.sh > "$_DOCKER_LOG" 2>&1; then
            echo "✗ Error: Docker installation failed"
            echo "--- Docker install output ---"
            cat "$_DOCKER_LOG"
            rm -f "$_DOCKER_LOG" get-docker.sh
            exit 1
        fi
        rm -f "$_DOCKER_LOG" get-docker.sh

        systemctl start docker
        systemctl enable docker > /dev/null 2>&1

        echo "✓ Docker installed successfully"
        return 0
    else
        echo ""
        echo "Error: Docker is required for this installation method."
        echo "Automatic Docker installation is disabled by default for safety."
        echo ""
        echo "Option 1: Install Docker manually, then rerun this script."
        echo "Option 2: Explicitly allow installer-managed Docker installation by setting:"
        echo "  IOTISTICA_INSTALL_DOCKER=yes"
        echo "  (or FORCE_INSTALL=1)"
        return 1
    fi
}

install_mosquitto_if_needed() {
    if ! command -v setfacl >/dev/null 2>&1; then
        echo "Installing ACL utilities..."
        apt-get install -y -qq --no-install-recommends acl > /dev/null || {
            echo "✗ Error: Failed to install ACL utilities"
            exit 1
        }
    fi

    if command -v mosquitto >/dev/null 2>&1; then
        echo "✓ Mosquitto is already installed ($(mosquitto -h 2>&1 | head -1))"
    else
        echo "Installing Mosquitto..."
        apt-get install -y -qq --no-install-recommends mosquitto mosquitto-clients > /dev/null || {
            echo "✗ Error: Failed to install Mosquitto"
            exit 1
        }
        echo "✓ Mosquitto installed successfully"
    fi

    systemctl enable mosquitto > /dev/null 2>&1
}

should_manage_mosquitto() {
    SHOULD_INSTALL_MOSQUITTO="no"

    if [ "$IOTISTICA_INSTALL_MOSQUITTO" = "yes" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "true" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "1" ]; then
        SHOULD_INSTALL_MOSQUITTO="yes"
    elif [ "$IOTISTICA_INSTALL_MOSQUITTO" = "no" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "false" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "0" ]; then
        SHOULD_INSTALL_MOSQUITTO="no"
    elif [ -f /etc/mosquitto/conf.d/iotistica.conf ]; then
        # Previously managed by us — continue managing on upgrade
        SHOULD_INSTALL_MOSQUITTO="yes"
    elif command -v mosquitto >/dev/null 2>&1; then
        SHOULD_INSTALL_MOSQUITTO="no"
    elif [ -e /dev/tty ]; then
        echo ""
        echo -n "Install and manage a local Mosquitto MQTT broker? (yes/no): " >/dev/tty
        read SHOULD_INSTALL_MOSQUITTO </dev/tty
    fi

    if [ "$SHOULD_INSTALL_MOSQUITTO" = "yes" ] || [ "$SHOULD_INSTALL_MOSQUITTO" = "y" ]; then
        return 0
    fi

    return 1
}

is_port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -tlnp 2>/dev/null | grep -q ":${port}[[:space:]]" && return 0 || return 1
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tlnp 2>/dev/null | grep -q ":${port}[[:space:]]" && return 0 || return 1
    else
        # fallback: try to bind briefly
        (echo > /dev/tcp/127.0.0.1/"$port") 2>/dev/null && return 0 || return 1
    fi
}

generate_password() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 18 | tr -d '/+=' | head -c 16
    else
        tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 16
    fi
}

mask_password() {
    local pw="$1"
    local len=${#pw}
    if [ "$len" -le 4 ]; then
        printf '****\n'
    else
        printf '%s' "$(echo "$pw" | cut -c1-2)"
        printf '%*s\n' $((len - 2)) '' | tr ' ' '*'
    fi
}

prompt_mqtt_credentials() {
    if [ -e /dev/tty ]; then
        # Restore terminal echo on interrupt
        trap 'stty echo 2>/dev/null' INT TERM

        echo "" >/dev/tty
        echo "Configure MQTT broker credentials:" >/dev/tty
        echo "" >/dev/tty

        echo -n "  MQTT username [admin]: " >/dev/tty
        read INPUT_USER </dev/tty
        MQTT_USERNAME_VALUE="${INPUT_USER:-admin}"

        echo "" >/dev/tty
        echo "  MQTT password options:" >/dev/tty
        echo "    1) Enter a password" >/dev/tty
        echo "    2) Auto-generate a secure password (recommended)" >/dev/tty
        echo -n "  Choice [2]: " >/dev/tty
        read PW_CHOICE </dev/tty
        PW_CHOICE="${PW_CHOICE:-2}"

        if [ "$PW_CHOICE" = "1" ]; then
            while true; do
                echo -n "  Password: " >/dev/tty
                stty -echo 2>/dev/null
                read INPUT_PW </dev/tty
                stty echo 2>/dev/null
                echo "" >/dev/tty
                if [ -z "$INPUT_PW" ]; then
                    echo "  Password cannot be empty." >/dev/tty
                    continue
                fi
                echo -n "  Confirm password: " >/dev/tty
                stty -echo 2>/dev/null
                read CONFIRM_PW </dev/tty
                stty echo 2>/dev/null
                echo "" >/dev/tty
                if [ "$INPUT_PW" != "$CONFIRM_PW" ]; then
                    echo "  Passwords do not match. Try again." >/dev/tty
                    continue
                fi
                MQTT_PASSWORD_VALUE="$INPUT_PW"
                break
            done
        else
            MQTT_PASSWORD_VALUE="$(generate_password)"
            echo "  Generated password: ${MQTT_PASSWORD_VALUE}" >/dev/tty
            echo "  (save this — it will not be shown again in full)" >/dev/tty
        fi

        trap - INT TERM
        echo "" >/dev/tty
    else
        MQTT_USERNAME_VALUE="${MQTT_USERNAME:-admin}"
        MQTT_PASSWORD_VALUE="${MQTT_PASSWORD:-$(generate_password)}"
    fi
}

configure_mosquitto_file_auth() {
    echo ""
    echo "=================================="
    echo "MQTT Broker Setup (Mosquitto)"
    echo "=================================="

    MQTT_AUTH_DIR_VALUE="/etc/mosquitto"
    MQTT_BROKER_HOST_VALUE="${MQTT_BROKER_HOST:-localhost}"
    MQTT_BROKER_PORT_VALUE="${MQTT_BROKER_PORT:-1883}"

    # Check if the desired port is already occupied by something other than Mosquitto.
    # If Mosquitto itself holds the port we are about to reconfigure it — no conflict.
    port_held_by_other() {
        local port="$1"
        is_port_in_use "$port" || return 1
        if command -v ss >/dev/null 2>&1; then
            ss -tlnp 2>/dev/null | grep ":${port}[[:space:]]" | grep -q "mosquitto" && return 1
        elif command -v lsof >/dev/null 2>&1; then
            lsof -i :"$port" -sTCP:LISTEN 2>/dev/null | grep -q "mosquitto" && return 1
        fi
        return 0
    }
    if port_held_by_other "$MQTT_BROKER_PORT_VALUE"; then
        echo ""
        echo "⚠️  Port $MQTT_BROKER_PORT_VALUE is already in use by another process."
        echo "   (A Docker container or existing service may be running on this port.)"
        echo ""
        if [ -e /dev/tty ]; then
            echo -n "Enter an alternative port for Mosquitto [8883]: " >/dev/tty
            read ALT_PORT </dev/tty
            MQTT_BROKER_PORT_VALUE="${ALT_PORT:-8883}"
            echo "→ Using port $MQTT_BROKER_PORT_VALUE"
        else
            echo "Error: Port $MQTT_BROKER_PORT_VALUE is in use. Set MQTT_BROKER_PORT=<port> and rerun."
            exit 1
        fi
    fi

    MQTT_BROKER_URL_VALUE="mqtt://${MQTT_BROKER_HOST_VALUE}:${MQTT_BROKER_PORT_VALUE}"

    install_mosquitto_if_needed

    mkdir -p /etc/mosquitto/conf.d
    mkdir -p /var/log/mosquitto
    chgrp mosquitto /etc/mosquitto
    chmod 2755 /etc/mosquitto

    if ! grep -q '^[[:space:]]*include_dir[[:space:]]\+/etc/mosquitto/conf.d[[:space:]]*$' /etc/mosquitto/mosquitto.conf 2>/dev/null; then
        echo "include_dir /etc/mosquitto/conf.d" >> /etc/mosquitto/mosquitto.conf
    fi

    cat > /etc/mosquitto/conf.d/iotistica.conf << EOFMOSQ
# Iotistica managed configuration

listener ${MQTT_BROKER_PORT_VALUE}
allow_anonymous false

password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl
EOFMOSQ

    touch /etc/mosquitto/passwd
    touch /etc/mosquitto/acl
    touch /var/log/mosquitto/mosquitto.log

    # Existing passwd file with entries — this is an upgrade, preserve credentials
    if [ -s /etc/mosquitto/passwd ]; then
        echo "✓ Existing MQTT credentials found — preserving"
        MQTT_CREDENTIALS_PRESERVED="yes"

        if [ -n "$MQTT_USERNAME" ] && [ -n "$MQTT_PASSWORD" ]; then
            MQTT_USERNAME_VALUE="$MQTT_USERNAME"
            MQTT_PASSWORD_VALUE="$MQTT_PASSWORD"
            mosquitto_passwd -b /etc/mosquitto/passwd "$MQTT_USERNAME_VALUE" "$MQTT_PASSWORD_VALUE" 2>/dev/null
            echo "  Added/updated user '${MQTT_USERNAME_VALUE}' (env override)"
        elif [ -f /etc/iotistic/agent.env ]; then
            MQTT_USERNAME_VALUE="$(grep '^MQTT_USERNAME=' /etc/iotistic/agent.env 2>/dev/null | cut -d= -f2-)"
            MQTT_PASSWORD_VALUE="$(grep '^MQTT_PASSWORD=' /etc/iotistic/agent.env 2>/dev/null | cut -d= -f2-)"
        fi
    else
        MQTT_CREDENTIALS_PRESERVED="no"

        if [ -n "$MQTT_USERNAME" ] && [ -n "$MQTT_PASSWORD" ]; then
            MQTT_USERNAME_VALUE="$MQTT_USERNAME"
            MQTT_PASSWORD_VALUE="$MQTT_PASSWORD"
        else
            prompt_mqtt_credentials
        fi

        mosquitto_passwd -b -c /etc/mosquitto/passwd "$MQTT_USERNAME_VALUE" "$MQTT_PASSWORD_VALUE" 2>/dev/null
        echo "✓ MQTT credentials configured (user: ${MQTT_USERNAME_VALUE})"

        cat > /etc/mosquitto/acl << EOFACL
# Iotistica managed ACL
user ${MQTT_USERNAME_VALUE}
topic readwrite #
EOFACL
    fi

    export MQTT_BROKER_HOST_VALUE MQTT_BROKER_PORT_VALUE MQTT_BROKER_URL_VALUE
    export MQTT_AUTH_DIR_VALUE MQTT_USERNAME_VALUE MQTT_PASSWORD_VALUE

    # root:mosquitto + 0640 lets the mosquitto service read the files without ACLs.
    # The iotistic agent user gets write access via setfacl when available (SD cards
    # without ACL mount option fall back to group write via the iotistic group).
    chown root:mosquitto /etc/mosquitto/passwd /etc/mosquitto/acl
    chmod 0640 /etc/mosquitto/passwd
    chmod 0640 /etc/mosquitto/acl
    chown mosquitto:mosquitto /var/log/mosquitto/mosquitto.log
    chmod 640 /var/log/mosquitto/mosquitto.log

    # Add iotistic user to mosquitto group so it can write passwd/acl without ACLs
    usermod -aG mosquitto iotistic 2>/dev/null || true

    if command -v setfacl >/dev/null 2>&1; then
        setfacl -m u:iotistic:rwx /etc/mosquitto || true
        setfacl -m u:iotistic:rw /etc/mosquitto/passwd || true
        setfacl -m u:iotistic:rw /etc/mosquitto/acl || true
    else
        echo "Note: setfacl not available; iotistic user will use group membership for auth file access"
    fi

    cat > /usr/local/bin/iotistica-mqtt-reload.sh << 'EOFRELOAD'
#!/bin/bash
set -e

chown root:mosquitto /etc/mosquitto/passwd /etc/mosquitto/acl
chmod 0640 /etc/mosquitto/passwd
chmod 0640 /etc/mosquitto/acl

if command -v setfacl >/dev/null 2>&1; then
    setfacl -m u:iotistic:rw /etc/mosquitto/passwd || true
    setfacl -m u:iotistic:rw /etc/mosquitto/acl || true
fi

systemctl reload mosquitto
EOFRELOAD
    chmod +x /usr/local/bin/iotistica-mqtt-reload.sh

    # Keep sudoers rule as a best-effort fallback for non-hardened environments.
    # The primary reload mechanism is the systemd path unit below, which does not
    # require the agent process to escalate privileges at all.
    cat > /etc/sudoers.d/iotistica-mqtt-reload << 'EOFSUDO'
iotistic ALL=(root) NOPASSWD: /usr/local/bin/iotistica-mqtt-reload.sh
EOFSUDO
    chmod 440 /etc/sudoers.d/iotistica-mqtt-reload

    # Install a systemd path unit that watches /etc/mosquitto/passwd and fires
    # iotistica-mqtt-reload.service (runs as root) whenever the agent writes
    # updated credentials. This works even when the agent service has
    # NoNewPrivileges=true (which blocks sudo from within the agent process).
    cat > /etc/systemd/system/iotistica-mqtt-reload.service << 'EOFSERVICE'
[Unit]
Description=Reload Mosquitto MQTT auth files after credential update
After=mosquitto.service
Requires=mosquitto.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/iotistica-mqtt-reload.sh
EOFSERVICE

    cat > /etc/systemd/system/iotistica-mqtt-reload.path << 'EOFPATH'
[Unit]
Description=Watch Mosquitto passwd file for credential updates

[Path]
PathModified=/etc/mosquitto/passwd
Unit=iotistica-mqtt-reload.service

[Install]
WantedBy=multi-user.target
EOFPATH

    systemctl daemon-reload
    systemctl enable --now iotistica-mqtt-reload.path > /dev/null 2>&1
    echo "✓ Mosquitto auto-reload path unit installed and active"

    systemctl restart mosquitto

    sleep 3

    if systemctl is-active --quiet mosquitto; then
        echo "✓ Mosquitto is running"
    else
        echo "✗ Mosquitto failed to start"
        systemctl status mosquitto --no-pager
        exit 1
    fi
}

echo ""
echo "Installation method: Systemd + Docker"
echo ""

# ============================================================================
# SYSTEMD INSTALLATION
# ============================================================================
    echo "==================================="
    echo "Systemd Installation"
    echo "==================================="
    echo ""

    # Check if systemd is available
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "Error: systemd is not available on this system"
        echo "Please use the Docker installation method instead"
        exit 1
    fi

    # Fail fast on unsupported OS families before running apt-get/dpkg commands.
    if ! is_debian_family; then
        echo "Error: Unsupported OS family for this installer: $OS${OS_VERSION:+ $OS_VERSION}"
        echo ""
        echo "This install path currently supports Debian-family distributions only"
        echo "(debian, ubuntu, raspbian, or ID_LIKE containing 'debian')."
        echo ""
        echo "Detected ID_LIKE: ${ID_LIKE:-<not-set>}"
        echo ""
        echo "Please use a Debian-based OS or add package-manager support for your distro"
        echo "(dnf/yum/apk/opkg) before running this script."
        exit 1
    fi

    # Install system dependencies
    echo "Installing system dependencies..."
    
    # Clean up package cache and fix broken dependencies
    apt-get clean > /dev/null 2>&1 || true
    dpkg --configure -a > /dev/null 2>&1 || true

    # Update package lists
    apt-get update -qq > /dev/null || {
        echo "Warning: apt-get update failed, continuing anyway..."
    }

    # Install essential dependencies first (these should always work)
    apt-get install -y -qq --no-install-recommends \
        curl wget git build-essential python3 make g++ > /dev/null 2>&1 || {
        echo "✗ Error: Failed to install essential build tools"
        exit 1
    }

    # Install database and utilities (skip if fails due to architecture issues)
    apt-get install -y -qq --no-install-recommends \
        sqlite3 libsqlite3-dev jq procps > /dev/null 2>&1 || {
        echo "Warning: Some database packages failed to install, continuing..."
    }

    # Install networking tools
    apt-get install -y -qq --no-install-recommends \
        iproute2 iptables net-tools iputils-ping > /dev/null 2>&1 || {
        echo "Warning: Some network tools failed to install"
    }

    echo "✓ System dependencies installed"

    # Install Docker (required for agent functionality)
    echo ""
    install_docker_if_needed "no"

    # Install Node.js 24 (or accept existing Node 22+)
    NODE_BIN=$(command -v node 2>/dev/null || echo "")
    [ -z "$NODE_BIN" ] && [ -x /usr/bin/node ]       && NODE_BIN=/usr/bin/node
    [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ] && NODE_BIN=/usr/local/bin/node

    if [ -z "$NODE_BIN" ]; then
        echo ""
        echo "Installing Node.js 24..."
        curl -fsSL https://deb.nodesource.com/setup_24.x 2>/dev/null | bash - > /dev/null 2>&1
        apt-get install -y -qq nodejs > /dev/null 2>&1
        echo "✓ Node.js installed successfully"
    else
        NODE_MAJOR_VERSION=$("$NODE_BIN" -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_MAJOR_VERSION" -lt 22 ]; then
            echo ""
            echo "Upgrading Node.js from v${NODE_MAJOR_VERSION} to 24..."
            curl -fsSL https://deb.nodesource.com/setup_24.x 2>/dev/null | bash - > /dev/null 2>&1
            apt-get install -y -qq nodejs > /dev/null 2>&1
            echo "✓ Node.js upgraded successfully"
        else
            echo "✓ Node.js $("$NODE_BIN" --version) already installed"
        fi
    fi

    # Create iotistic user
    if ! id -u iotistic > /dev/null 2>&1; then
        echo ""
        echo "Creating iotistic user..."
        useradd --system --home-dir /opt/iotistic --shell /bin/bash iotistic
        usermod -aG docker iotistic
        echo "✓ User created and added to docker group"
    else
        echo ""
        echo "✓ User iotistic already exists"
        # Ensure user is in docker group even if already exists
        usermod -aG docker iotistic 2>/dev/null || true
    fi

    MQTT_BROKER_URL_VALUE="${MQTT_BROKER_URL:-}"
    MQTT_AUTH_DIR_VALUE=""
    MQTT_USERNAME_VALUE="${MQTT_USERNAME:-}"
    MQTT_PASSWORD_VALUE="${MQTT_PASSWORD:-}"
    MQTT_CREDENTIALS_PRESERVED="no"
    MANAGE_LOCAL_MOSQUITTO="no"

    if should_manage_mosquitto; then
        MANAGE_LOCAL_MOSQUITTO="yes"
        configure_mosquitto_file_auth
    else
        echo ""
        echo "Skipping local Mosquitto installation/configuration"
        echo "To enable it explicitly, rerun with IOTISTICA_INSTALL_MOSQUITTO=yes"
    fi

    # Create directories
    mkdir -p /opt/iotistic/agent
    mkdir -p /etc/iotistic
    mkdir -p /var/lib/iotistic/agent
    mkdir -p /var/log/iotistic
    
    # Create OPC UA PKI directory tree (node-opcua-certificate-manager expects the full structure)
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/own/certs
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/own/private
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/trusted/certs
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/trusted/crl
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/rejected/certs
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/issuers/certs
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI/issuers/crl
    chown -R iotistic:iotistic /opt/iotistic/.config

    # Detect if we're running from a checked-out repository FIRST
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    AGENT_DIR="$(dirname "$SCRIPT_DIR")"
    
    # Function to normalize API endpoint URL
    normalize_api_endpoint() {
        if [ -n "$IOTISTICA_API" ] && ! echo "$IOTISTICA_API" | grep -qE '^https?://'; then
            IOTISTICA_API="http://${IOTISTICA_API}"
            echo "Auto-prepended http:// to API endpoint: $IOTISTICA_API"
        fi
    }
    
        # Provisioning is done through the web admin UI after installation.
    # Cloud mode can be enabled by setting IOTISTICA_API + PROVISIONING_KEY env vars
    # before running this script (e.g. for automated fleet deployments).
    DEVICE_API_PORT="${IOTISTICA_DEVICE_PORT:-48484}"
    AGENT_VERSION="${IOTISTICA_AGENT_VERSION:-dev}"
    IOTISTICA_API="${IOTISTICA_API:-}"
    PROVISIONING_KEY="${PROVISIONING_KEY:-}"

    # Normalize API endpoint - add http:// if protocol missing
    normalize_api_endpoint
    
    # If package.json exists in AGENT_DIR, extract version from it
    # This handles the case where install.sh is run from an extracted tarball
    if [ "$AGENT_VERSION" = "dev" ] && [ -f "$AGENT_DIR/package.json" ]; then
        EXTRACTED_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGENT_DIR/package.json" | sed 's/.*"\([^"]*\)".*/\1/')
        if [ -n "$EXTRACTED_VERSION" ]; then
            AGENT_VERSION="$EXTRACTED_VERSION"
        fi
    fi
    
    INSTALL_SOURCE="${IOTISTICA_INSTALL_SOURCE:-auto}"
    USE_LOCAL_REPO="no"

    case "$INSTALL_SOURCE" in
        repo|local)
            USE_LOCAL_REPO="yes"
            ;;
        artifact|remote|blob)
            USE_LOCAL_REPO="no"
            ;;
        auto)
            if [ -d "$AGENT_DIR/.git" ] && [ -f "$AGENT_DIR/package.json" ]; then
                USE_LOCAL_REPO="yes"
            fi
            ;;
        *)
            echo "Warning: Unknown IOTISTICA_INSTALL_SOURCE='$INSTALL_SOURCE' - defaulting to auto"
            if [ -d "$AGENT_DIR/.git" ] && [ -f "$AGENT_DIR/package.json" ]; then
                USE_LOCAL_REPO="yes"
            fi
            ;;
    esac

    if [ "$USE_LOCAL_REPO" = "yes" ]; then
        echo "Using repository sources from: $AGENT_DIR"
        
        # Copy agent code
        echo "Copying agent code..."
        cp -r "$AGENT_DIR"/* /opt/iotistic/agent/
        
        echo "✓ Repository code copied to /opt/iotistic/agent"
    else
        # Download pre-built agent from Azure Blob Storage
        echo "Downloading agent from distribution server..."
        
        # Detect architecture for platform-specific tarball
        DETECTED_ARCH=$(uname -m)
        case "$DETECTED_ARCH" in
            aarch64|arm64)
                TARBALL_SUFFIX="-arm64"
                ;;
            x86_64|amd64)
                TARBALL_SUFFIX="-x86_64"
                ;;
            *)
                TARBALL_SUFFIX=""
                echo "Warning: Unknown architecture ($DETECTED_ARCH), using generic tarball"
                ;;
        esac
        
        DOWNLOAD_BASE_URL="${IOTISTICA_DOWNLOAD_BASE_URL:-https://get.iotistica.com/agent/artifacts}"

        # Determine download URL
        if [ -n "$IOTISTICA_DOWNLOAD_URL" ]; then
            # Custom URL provided
            DOWNLOAD_URL="$IOTISTICA_DOWNLOAD_URL"
        elif [ "$AGENT_VERSION" = "dev" ] || [ "$AGENT_VERSION" = "latest" ]; then
            # Use latest version with architecture suffix
            DOWNLOAD_URL="${DOWNLOAD_BASE_URL}/agent-latest${TARBALL_SUFFIX}.tar.gz"
        else
            # Use specific version with architecture suffix
            DOWNLOAD_URL="${DOWNLOAD_BASE_URL}/versions/agent-${AGENT_VERSION}${TARBALL_SUFFIX}.tar.gz"
        fi
        
        cd /tmp
        rm -rf iotistic-agent-download
        
        # Try to download with curl or wget
        if command -v curl > /dev/null 2>&1; then
            curl -fsSL -o agent.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
        elif command -v wget > /dev/null 2>&1; then
            wget -O agent.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
        else
            echo "Error: Neither curl nor wget is available"
            exit 1
        fi
        
        if [ "$DOWNLOAD_FAILED" = "1" ]; then
            echo ""
            echo "Error: Failed to download agent from distribution server"
            echo ""
            echo "Troubleshooting:"
            echo "  1. Check your internet connection"
            echo "  2. Verify the download URL: $DOWNLOAD_URL"
            echo "  3. Verify the agent version exists: $AGENT_VERSION"
            echo ""
            echo "Available versions: https://iotistic.blob.core.windows.net/scripts/agent/versions/"
            echo ""
            echo "For development/internal installations:"
            echo "  Run this script from within a cloned repository:"
            echo "    git clone https://github.com/Iotistica/iot-agent.git"
            echo "    cd iot-agent/bin"
            echo "    sudo ./install.sh"
            exit 1
        fi
        
        echo "Extracting agent..."
        mkdir -p iotistic-agent-download
        tar -xzf agent.tar.gz -C iotistic-agent-download || {
            echo "Error: Failed to extract agent tarball"
            exit 1
        }

        # Stop running agent before overwriting files
        if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
            systemctl stop "${SERVICE_NAME}"
        fi

        # Clean up ALL existing installation files to ensure fresh install
        rm -rf /opt/iotistic/agent/node_modules
        rm -f /opt/iotistic/agent/package-lock.json
        rm -f /opt/iotistic/agent/package.json
        
        # Copy extracted files to installation directory
        cp -r iotistic-agent-download/* /opt/iotistic/agent/ || {
            echo "Error: Failed to copy agent files"
            exit 1
        }
        
        
        # Cleanup
        rm -rf iotistic-agent-download agent.tar.gz
        
        echo "✓ Agent downloaded and installed"
        SKIP_BUILD=true

        if [ "$AGENT_VERSION" = "dev" ] && [ -f /opt/iotistic/agent/package.json ]; then
            EXTRACTED_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /opt/iotistic/agent/package.json | sed 's/.*"\([^"]*\)".*/\1/')
            if [ -n "$EXTRACTED_VERSION" ]; then
                AGENT_VERSION="$EXTRACTED_VERSION"
            fi
        fi
    fi

    # Build agent (only if using repository checkout)
    if [ "$SKIP_BUILD" != "true" ]; then
        echo ""
        echo "Installing agent dependencies..."
        cd /opt/iotistic/agent
        npm ci --legacy-peer-deps

        echo "Building agent..."
        npx tsc --project tsconfig.build.json
        
        echo "Copying database assets..."
        npm run copy:db-assets
        if [ ! -f dist/db/template.sqlite.sql ]; then
            echo "✗ Error: Database asset copy failed - dist/db/template.sqlite.sql not found"
            exit 1
        fi

        if [ ! -f dist/app.js ]; then
            echo "✗ Error: Build failed - dist/app.js not found"
            exit 1
        fi
        echo "✓ Agent built successfully"

        # Build web admin UI
        if [ -d /opt/iotistic/agent/admin ]; then
            echo ""
            echo "Building web admin UI..."
            cd /opt/iotistic/agent/admin
            npm ci --legacy-peer-deps
            npm run build
            if [ ! -d dist ]; then
                echo "✗ Error: Admin UI build failed - dist/ not found"
                exit 1
            fi
            echo "✓ Web admin UI built successfully"
            cd /opt/iotistic/agent
        else
            echo "Warning: admin/ directory not found, skipping web admin build"
        fi
    else
        # Verify pre-built files exist
        cd /opt/iotistic/agent

        if [ ! -d dist ]; then
            echo "✗ Error: Pre-built dist/ directory not found"
            exit 1
        fi
        
        # Check for app.js in multiple possible locations
        if [ -f dist/app.js ]; then
            true
        elif [ -f dist/src/app.js ]; then
            true
        else
            echo "✗ Error: Pre-built app.js not found"
            echo "Searched in:"
            echo "  - dist/app.js"
            echo "  - dist/src/app.js"
            echo ""
            echo "Available files:"
            find dist -name "*.js" | head -20
            exit 1
        fi
        
        echo "✓ Pre-built agent verified (architecture-specific native modules included)"

        # ARM64: always rebuild native modules from source.
        # The tarball is built on x86_64 CI runners so bundled .node binaries are x86_64
        # and will not load on aarch64. Unconditional — no detection needed.
        if [ "$ARCH" = "aarch64" ] && ! (cd /opt/iotistic/agent && node -e "require('better-sqlite3');require('node-pty')" > /dev/null 2>&1); then
            echo ""
            apt-get install -y -qq --no-install-recommends build-essential python3 libsqlite3-dev > /dev/null || {
                echo "✗ Error: Failed to install build tools for native module compilation"
                exit 1
            }
            cd /opt/iotistic/agent
            _BUILD_LOG=$(mktemp)
            if ! npm rebuild better-sqlite3 node-pty --build-from-source > "$_BUILD_LOG" 2>&1; then
                echo "✗ Error: Failed to compile native modules for ARM64"
                echo "--- Build output ---"
                cat "$_BUILD_LOG"
                rm -f "$_BUILD_LOG"
                exit 1
            fi
            rm -f "$_BUILD_LOG"
            echo "✓ Native modules compiled for aarch64"
        fi

        # Verify admin UI is included in the tarball
        if [ -d /opt/iotistic/agent/admin/dist ]; then
            echo "✓ Web admin UI dist included in tarball"
        else
            echo "Warning: admin/dist not found in tarball — web admin UI will not be available"
        fi
    fi

    # Install update script
    if [ -f /opt/iotistic/agent/bin/update.sh ]; then
        cp /opt/iotistic/agent/bin/update.sh /usr/local/bin/update.sh
        chmod +x /usr/local/bin/update.sh
    fi

    # Create environment file
    
    # Generate device UUID if not already set
    if [ ! -f /var/lib/iotistic/agent/device-uuid ]; then
        DEVICE_UUID=$(cat /proc/sys/kernel/random/uuid)
        echo "$DEVICE_UUID" > /var/lib/iotistic/agent/device-uuid
    else
        DEVICE_UUID=$(cat /var/lib/iotistic/agent/device-uuid)
    fi
    
    API_SECURITY_MODE_VALUE="${API_SECURITY_MODE:-LOCAL_NETWORK}"

    cat > /etc/iotistic/agent.env << EOF
AGENT_VERSION=${AGENT_VERSION}
BUILD_ID=${BUILD_ID}
DEVICE_API_PORT=${DEVICE_API_PORT}
DEVICE_UUID=${DEVICE_UUID}
NODE_ENV=production
LOG_LEVEL=info
API_SECURITY_MODE=${API_SECURITY_MODE_VALUE}
ORCHESTRATOR_TYPE=docker-compose
ORCHESTRATOR_INTERVAL=30000
DATA_DIR=/var/lib/iotistic/agent
STATE_FILE=/var/lib/iotistic/agent/target-state.json
DATABASE_PATH=/var/lib/iotistic/agent/agent.sqlite
EOF

    # Run in standalone mode by default — provisioning is done via the web admin UI.
    # Only skip STANDALONE when IOTISTICA_API is explicitly provided (cloud/fleet deployments).
    if [ -z "$IOTISTICA_API" ]; then
        echo "STANDALONE=true" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_BROKER_URL_VALUE" ]; then
        echo "MQTT_BROKER_URL=${MQTT_BROKER_URL_VALUE}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_AUTH_DIR_VALUE" ]; then
        echo "MQTT_AUTH_DIR=${MQTT_AUTH_DIR_VALUE}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_USERNAME_VALUE" ]; then
        echo "MQTT_USERNAME=${MQTT_USERNAME_VALUE}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_PASSWORD_VALUE" ]; then
        echo "MQTT_PASSWORD=${MQTT_PASSWORD_VALUE}" >> /etc/iotistic/agent.env
    fi

    # Write CI mode flag if set (for testing environments)
    if [ "$CI" = "true" ]; then
        echo "CI=true" >> /etc/iotistic/agent.env
        echo "SYSTEMD_READY_MODE=ci" >> /etc/iotistic/agent.env
    fi

    if [ -n "$PROVISIONING_KEY" ]; then
        echo "PROVISIONING_KEY=${PROVISIONING_KEY}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$INITIAL_ADMIN_PASSWORD" ]; then
        echo "INITIAL_ADMIN_PASSWORD=${INITIAL_ADMIN_PASSWORD}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$IOTISTICA_API" ]; then
        echo "IOTISTICA_API=${IOTISTICA_API}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_USE_TLS" ]; then
        echo "MQTT_USE_TLS=${MQTT_USE_TLS}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$AGENT_SHELL_HMAC_KEY" ]; then
        echo "AGENT_SHELL_HMAC_KEY=${AGENT_SHELL_HMAC_KEY}" >> /etc/iotistic/agent.env
    fi

    # Set permissions
    chown -R iotistic:iotistic /opt/iotistic/agent
    chown -R iotistic:iotistic /var/lib/iotistic/agent
    chown -R iotistic:iotistic /var/log/iotistic
    chown iotistic:iotistic /etc/iotistic/agent.env
    chmod 600 /etc/iotistic/agent.env

    # Create systemd service

    NODE_PATH=$(command -v node)
    
    # Auto-detect correct app.js path (handles both old and new build structures)
    if [ -f /opt/iotistic/agent/dist/app.js ]; then
        APP_JS_PATH="/opt/iotistic/agent/dist/app.js"
    elif [ -f /opt/iotistic/agent/dist/src/app.js ]; then
        APP_JS_PATH="/opt/iotistic/agent/dist/src/app.js"
    else
        echo "✗ Error: Could not find app.js in dist/ or dist/src/"
        exit 1
    fi

    # Allow install-time override for service memory cap.
    AGENT_MEMORY_LIMIT="${AGENT_MEMORY_LIMIT:-300M}"
    AGENT_MEMORY_HIGH="${AGENT_MEMORY_HIGH:-250M}"

    SERVICE_TYPE="notify"
    WATCHDOG_DIRECTIVES="# Watchdog configuration (health-gated automatic restart)
WatchdogSec=60
NotifyAccess=all"
    STARTUP_TIMEOUT="120"

    if [ "$CI" = "true" ]; then
        echo "CI mode: using systemd Type=simple and disabling watchdog for deterministic startup tests"
        SERVICE_TYPE="simple"
        WATCHDOG_DIRECTIVES="# Watchdog disabled in CI service mode"
        STARTUP_TIMEOUT="60"
    fi

    UNIT_AFTER="network-online.target docker.service"
    UNIT_REQUIRES="docker.service"
    SERVICE_READWRITE_PATHS="/var/lib/iotistic /var/log/iotistic /opt/iotistic/agent /opt/iotistic/.config /var/run/docker.sock"

    if [ "$MANAGE_LOCAL_MOSQUITTO" = "yes" ]; then
        UNIT_AFTER="$UNIT_AFTER mosquitto.service"
        UNIT_REQUIRES="$UNIT_REQUIRES mosquitto.service"
        SERVICE_READWRITE_PATHS="$SERVICE_READWRITE_PATHS /etc/mosquitto"
    fi
    
    cat > /etc/systemd/system/${SERVICE_NAME}.service << EOFSVC
[Unit]
Description=Iotistic Agent - IoT Device Management Service
Documentation=https://github.com/Iotistica/iotistic
After=${UNIT_AFTER}
Requires=${UNIT_REQUIRES}
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
# Service type differs between production and CI mode
Type=${SERVICE_TYPE}
User=iotistic
Group=iotistic
WorkingDirectory=/opt/iotistic/agent
EnvironmentFile=/etc/iotistic/agent.env
Environment=NODE_ENV=production
Environment=DEPLOYMENT_TYPE=systemd

ExecStart=$NODE_PATH $APP_JS_PATH

# Restart policy (automatic recovery from failures)
Restart=always
RestartSec=5

${WATCHDOG_DIRECTIVES}

# Startup timeout
TimeoutStartSec=${STARTUP_TIMEOUT}

# Graceful shutdown timeout (kill misbehaving services)
TimeoutStopSec=20
KillMode=control-group

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security hardening (production recommended)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${SERVICE_READWRITE_PATHS}
CapabilityBoundingSet=
LockPersonality=true
MemoryAccounting=true
CPUAccounting=true

# Resource limits (prevent memory leaks from killing device)
LimitNOFILE=65536
LimitNPROC=65536
MemoryHigh=${AGENT_MEMORY_HIGH}
MemoryMax=${AGENT_MEMORY_LIMIT}
TasksMax=512
CPUQuota=80%

[Install]
WantedBy=multi-user.target
EOFSVC

    # Configure journald limits (prevent disk exhaustion on edge devices)
    # Configure journald log limits
    
    # Use drop-in config instead of overwriting system file
    mkdir -p /etc/systemd/journald.conf.d
    
    cat > /etc/systemd/journald.conf.d/iotistic.conf << EOFJOURNALD
[Journal]
# Disk storage limits (important for edge devices)
SystemMaxUse=200M
RuntimeMaxUse=100M
MaxRetentionSec=7day

# Keep logs structured and compressed
Compress=yes
Storage=persistent
EOFJOURNALD

    # Restart journald to apply limits
    systemctl restart systemd-journald > /dev/null 2>&1

    # Verify agent.env permissions before starting service
    if [ "$(stat -c %a /etc/iotistic/agent.env)" != "600" ]; then
        echo "✗ Error: agent.env permissions are insecure"
        echo "Expected: 600, Found: $(stat -c %a /etc/iotistic/agent.env)"
        exit 1
    fi

    
    # Start (or restart) service
    systemctl daemon-reload
    echo ""
    echo "Starting agent service..."
    systemctl enable "${SERVICE_NAME}" > /dev/null 2>&1
    systemctl restart "${SERVICE_NAME}"

    sleep 10

    if systemctl is-active --quiet "${SERVICE_NAME}"; then
        echo ""
        echo "✓ Agent service is running"
        echo ""
        echo "====================================="
        echo "Installation complete!"
        echo "====================================="
        echo ""
        echo "Agent is running as systemd service '${SERVICE_NAME}'"
        echo "Admin UI:   http://$(hostname -I | awk '{print $1}'):${DEVICE_API_PORT}/admin"
        echo ""
        echo "Admin login — username: admin"
        if [ -n "$INITIAL_ADMIN_PASSWORD" ]; then
            echo "  Password:  (set via INITIAL_ADMIN_PASSWORD)"
        else
            echo "  The initial password was generated on first start."
            echo "  Retrieve it with:  journalctl -u ${SERVICE_NAME} | grep 'Password:'"
        fi
        echo "  You will be required to change it on first login."
        echo ""
        if [ -z "$IOTISTICA_API" ]; then
        echo "Running in standalone mode."
        echo "  To connect to Iotistica Cloud, go to Settings → Cloud Sync in the admin UI."
        echo ""
        fi
        if [ "$MANAGE_LOCAL_MOSQUITTO" = "yes" ]; then
            echo "Local MQTT broker: ${MQTT_BROKER_URL_VALUE}"
            if [ "$MQTT_CREDENTIALS_PRESERVED" = "yes" ]; then
                echo "  Credentials: preserved from previous installation"
            else
                echo "  Username: ${MQTT_USERNAME_VALUE}"
                echo "  Password: $(mask_password "$MQTT_PASSWORD_VALUE")"
            fi
            echo ""
        fi
        echo ""
    else
        echo ""
        echo "✗ Error: Agent service failed to start"
        systemctl status "${SERVICE_NAME}" --no-pager
        journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
        exit 1
    fi

    # ============================================================================
    # CLI (iotctl) INSTALLATION
    # Install the iotctl CLI tool so operators can manage the device from the
    # command line. Skipped when IOTISTICA_INSTALL_CLI=no.
    # ============================================================================
    INSTALL_CLI="${IOTISTICA_INSTALL_CLI:-yes}"
    if [ "$INSTALL_CLI" = "no" ] || [ "$INSTALL_CLI" = "false" ] || [ "$INSTALL_CLI" = "0" ]; then
        echo ""
        echo "Skipping CLI installation (IOTISTICA_INSTALL_CLI=$INSTALL_CLI)"
        echo "To install later: curl -sfL https://get.iotistica.com/agent-cli | sudo sh"
    else
        echo ""
        echo "=================================="
        echo "Installing iotctl CLI"
        echo "=================================="

        # Export the same download base URL so cli-install.sh can derive its URL
        export DOWNLOAD_BASE_URL

        # Locate cli-install.sh: prefer a copy bundled with the agent tarball,
        # fall back to downloading it from the CDN.
        CLI_INSTALLER="/opt/iotistic/agent/bin/cli-install.sh"

        if [ ! -f "$CLI_INSTALLER" ]; then
            echo "cli-install.sh not found in agent bundle, downloading from CDN..."
            CLI_CDN_BASE="${DOWNLOAD_BASE_URL:-https://get.iotistica.com/agent/artifacts}"
            CLI_CDN_BASE="${CLI_CDN_BASE%%/agent*}"
            CLI_INSTALLER_URL="${CLI_CDN_BASE}/agent-cli/cli-install.sh"

            if command -v curl >/dev/null 2>&1; then
                curl -fsSL -o /tmp/cli-install.sh "$CLI_INSTALLER_URL" || {
                    echo "Warning: Could not download cli-install.sh - skipping CLI install"
                    CLI_INSTALLER=""
                }
            elif command -v wget >/dev/null 2>&1; then
                wget -O /tmp/cli-install.sh "$CLI_INSTALLER_URL" || {
                    echo "Warning: Could not download cli-install.sh - skipping CLI install"
                    CLI_INSTALLER=""
                }
            else
                echo "Warning: Neither curl nor wget available - skipping CLI install"
                CLI_INSTALLER=""
            fi

            [ -n "$CLI_INSTALLER" ] && CLI_INSTALLER="/tmp/cli-install.sh"
        fi

        if [ -n "$CLI_INSTALLER" ] && [ -f "$CLI_INSTALLER" ]; then
            chmod +x "$CLI_INSTALLER"
            sh "$CLI_INSTALLER" && echo "✓ iotctl CLI installed" || {
                echo "Warning: CLI installation failed (non-fatal)"
                echo "You can install it later: curl -sfL https://get.iotistica.com/agent-cli | sudo sh"
            }
        fi
    fi
