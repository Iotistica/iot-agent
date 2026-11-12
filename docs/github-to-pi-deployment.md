# GitHub Actions → Raspberry Pi deployment

Quick setup notes for deploying the Iotistica agent from a **Windows self-hosted GitHub Actions runner** to the Raspberry Pi using **PuTTY Plink**.

## 1. Prepare the Raspberry Pi

SSH into the Pi:

```bash
ssh zemfyre@10.0.0.80
```

Allow the deployment user to run sudo without an interactive password:

```bash
sudo visudo -f /etc/sudoers.d/zemfyre
```

Add this line:

```text
zemfyre ALL=(ALL) NOPASSWD: ALL
```

Save, then set permissions and test:

```bash
sudo chmod 440 /etc/sudoers.d/zemfyre
sudo visudo -cf /etc/sudoers.d/zemfyre
sudo -k
sudo -n whoami
```

Expected result: `root`, without a password prompt.

> Security: This grants unrestricted passwordless sudo to `zemfyre`. For production, restrict it to required deployment commands instead.

## 2. Get the Pi's SSH host key fingerprint

On the Pi:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

The fingerprint we obtained during setup was:

```text
SHA256:L/r2R13Zjw4OE4ZG6x3Ly73XDdRE70PeGT1TxA/v1WI
```

For the PuTTY Plink `-hostkey` option, set the GitHub secret `PI_SSH_HOST_KEY` to:

```text
ssh-ed25519 256 SHA256:L/r2R13Zjw4OE4ZG6x3Ly73XDdRE70PeGT1TxA/v1WI
```

**Verify the current fingerprint on the Pi before using this value**, especially after reinstalling the OS or regenerating host keys. The host key verifies the *server*; it is not the SSH login password or sudo password.

## 3. Configure GitHub Actions secrets

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** (or update existing secrets).

| Secret | Value |
|---|---|
| `PI_SSH_HOST` | `10.0.0.80` (or the Pi's current address) |
| `PI_SSH_USER` | `zemfyre` |
| `PI_SSH_PASS` | SSH login password for `zemfyre` |
| `PI_SSH_HOST_KEY` | Verified Plink host key fingerprint from step 2 |

The workflow currently uses SSH password authentication via Plink `-pw`. **Passwordless sudo does not mean passwordless SSH.** For passwordless SSH as well, switch to SSH key-pair authentication and a protected private-key secret.

## 4. Deploy with the Windows self-hosted runner

Ensure PuTTY/Plink is installed at `C:\Program Files\PuTTY\plink.exe` on the runner. Example `.github/workflows/deploy-test-pi.yml`:

```yaml
name: Deploy to Test Pi

on:
  workflow_run:
    workflows: ["Agent Release", "CI Build, Test & Push Agent"]
    branches: [main]
    types: [completed]
  workflow_dispatch:

env:
  PLINK: C:\Program Files\PuTTY\plink.exe
  PLINK_ARGS: '-batch -hostkey "${{ secrets.PI_SSH_HOST_KEY }}"'

jobs:
  deploy:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: [self-hosted]
    steps:
      - name: Deploy agent
        shell: cmd
        run: >
          "%PLINK%" %PLINK_ARGS%
          -pw "${{ secrets.PI_SSH_PASS }}"
          ${{ secrets.PI_SSH_USER }}@${{ secrets.PI_SSH_HOST }}
          "curl -fsSL https://get.iotistica.com/agent/builds/latest/install.sh -o /tmp/iotistica-install.sh && sudo -n env DEBIAN_FRONTEND=noninteractive IOTISTICA_NONINTERACTIVE=yes IOTISTICA_INSTALL_DOCKER=yes IOTISTICA_INSTALL_MOSQUITTO=yes IOTISTICA_DOWNLOAD_BASE_URL=https://get.iotistica.com/agent/builds/latest sh /tmp/iotistica-install.sh"

      - name: Verify services
        shell: cmd
        run: >
          "%PLINK%" %PLINK_ARGS%
          -pw "${{ secrets.PI_SSH_PASS }}"
          ${{ secrets.PI_SSH_USER }}@${{ secrets.PI_SSH_HOST }}
          "sudo -n systemctl is-active iotistica-agent && sudo -n systemctl is-active mosquitto"
```

The `IOTISTICA_NONINTERACTIVE=yes` flag requires the **updated installer** to be published at the download URL. The older installer still attempts to access `/dev/tty` when configuring MQTT credentials.

## 5. Verify and troubleshoot

On the Pi:

```bash
sudo -n whoami
sudo systemctl status iotistica-agent --no-pager
sudo systemctl status mosquitto --no-pager
sudo journalctl -u iotistica-agent -n 50 --no-pager
```

To locate the initial admin UI password if it was generated on first start:

```bash
sudo journalctl -u iotistica-agent --no-pager | grep 'Password:'
```

Treat passwords and deployment logs as sensitive. If Plink reports a host-key mismatch, **verify the Pi's actual ED25519 fingerprint** and update `PI_SSH_HOST_KEY`; do not disable host-key checking.
