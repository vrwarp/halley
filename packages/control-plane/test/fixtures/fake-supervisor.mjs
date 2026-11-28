// Stand-in for workspace-runner's supervisor: binds SUPERVISOR_PORT and serves /health. Like the
// real one, a failed bind is only logged (its uncaughtException handler keeps the process alive).
import http from 'node:http';

process.on('uncaughtException', (err) => {
  console.error(`supervisor: uncaughtException ${err && err.code} ${err && err.message}`);
});
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, pid: process.pid }));
});
server.listen(Number(process.env.SUPERVISOR_PORT), process.env.SUPERVISOR_BIND_HOST || '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
