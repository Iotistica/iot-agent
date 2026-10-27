import { createServer } from 'net';
import { unlinkSync } from 'fs';

const socketPath = process.env.EDGE_IPC_SOCKET || '/run/edge-ipc/app.sock';

try { unlinkSync(socketPath); } catch {}

const server = createServer((conn) => {
  const remote = `${conn.remoteAddress ?? 'agent'}`;
  console.log(`[connect] ${remote}`);

  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        console.log(`[msg] topic=${msg.topic} ts=${msg.ts} data=${typeof msg.data === 'string' ? msg.data.slice(0, 120) : JSON.stringify(msg.data).slice(0, 120)}`);
      } catch {
        console.log(`[raw] ${line.slice(0, 200)}`);
      }
    }
  });

  conn.on('close', () => console.log(`[disconnect] ${remote}`));
  conn.on('error', (err) => console.error(`[error] ${err.message}`));
});

server.listen(socketPath, () => {
  console.log(`Socket listener ready at ${socketPath}`);
  console.log('Waiting for agent to publish data...');
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
