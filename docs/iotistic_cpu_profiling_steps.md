# IoTistic CPU profiling — Raspberry Pi to Windows

## 1. On Raspberry Pi: verify watchdog is off

```bash
systemctl show iotistica-agent.service -p WatchdogUSec -p MainPID
```

Proceed only if `WatchdogUSec=0`. If not, temporarily disable it:

```bash
sudo mkdir -p /etc/systemd/system/iotistica-agent.service.d
printf '[Service]\nWatchdogSec=0\n' | sudo tee /etc/systemd/system/iotistica-agent.service.d/disable-watchdog.conf
sudo systemctl daemon-reload
sudo systemctl restart iotistica-agent.service
```

## 2. On Raspberry Pi: create profiler script (once)

```bash
cat > /tmp/profile-iotistic.cjs <<'EOF_SCRIPT'
const fs = require('node:fs');

async function main() {
  const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
  const url = targets[0]?.webSocketDebuggerUrl;
  if (!url) throw new Error('Inspector target not found');

  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 1000 });
    await send('Profiler.start');
    console.log('Profiling for 20 seconds...');
    await new Promise(resolve => setTimeout(resolve, 20000));
    const { profile } = await send('Profiler.stop');
    fs.writeFileSync('/tmp/iotistic.cpuprofile', JSON.stringify(profile));
    console.log('Saved /tmp/iotistic.cpuprofile; samples:', profile.samples?.length);
  } finally {
    ws.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
EOF_SCRIPT
```

## 3. On Raspberry Pi: enable Inspector and capture

```bash
PID=$(systemctl show -p MainPID --value iotistica-agent.service)
sudo kill -USR1 "$PID"
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1 && break
  sleep 0.2
done
sudo ss -ltnp | grep 9229   # must show 127.0.0.1:9229
node /tmp/profile-iotistic.cjs
ls -lh /tmp/iotistic.cpuprofile
```

## 4. On Windows PowerShell: copy to Downloads

```powershell
scp zemfyre@raspberry-pi-iotistica:/tmp/iotistic.cpuprofile "$env:USERPROFILE\Downloads\"
```

If SSH warns **REMOTE HOST IDENTIFICATION HAS CHANGED**, verify the host fingerprint **on the Pi** before updating `known_hosts`:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Only after verifying the fingerprint matches the one Windows displays:

```powershell
ssh-keygen -R raspberry-pi-iotistica
```

Then retry `scp` and confirm the new fingerprint before accepting.

## 5. On Windows: verify and upload

```powershell
Get-Item "$env:USERPROFILE\Downloads\iotistic.cpuprofile"
```

Upload `iotistic.cpuprofile` from **Downloads** to the chat.

## 6. Restore watchdog after testing

```bash
sudo rm /etc/systemd/system/iotistica-agent.service.d/disable-watchdog.conf
sudo systemctl daemon-reload
sudo systemctl restart iotistica-agent.service
systemctl show iotistica-agent.service -p WatchdogUSec
```

Expected: `WatchdogUSec=1min` (assuming the original service still sets `WatchdogSec=60`).

**Security:** Inspector grants code-execution access; keep it bound to `127.0.0.1`. Restarting the service closes the Inspector activated with `SIGUSR1`.
