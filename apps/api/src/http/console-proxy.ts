import type { ConsoleUpstream } from '@cloudpilot/hypervisor-sdk';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

const PATH = '/v1/console/ws';
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

/**
 * Browser ⇄ hypervisor console relay.
 *
 * The browser connects to /v1/console/ws?token=… with a single-use 60-second token
 * from POST …/console. The proxy redeems the token, opens the provider's console
 * websocket with the provider credentials (which never reach the browser) and pipes
 * frames both ways. Unknown/expired/reused tokens are rejected before upgrading.
 */
export function attachConsoleProxy(server: Server, redeem: (token: string) => Promise<ConsoleUpstream | null>, log: (m: string, e?: unknown) => void = () => {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== PATH) return; // not ours (leave for other handlers)
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const token = url.searchParams.get('token') ?? '';
    let upstream: ConsoleUpstream | null = null;
    try {
      upstream = token ? await redeem(token) : null;
    } catch (e) {
      log('console token redemption failed', e);
    }
    if (!upstream) return reject(401, 'Unauthorized');

    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const remote = new WebSocket(upstream.url, protocols.length ? protocols : ['binary'], {
      headers: upstream.headers,
      ca: upstream.caCertificate,
      rejectUnauthorized: upstream.rejectUnauthorized,
      perMessageDeflate: false,
    });
    remote.binaryType = 'nodebuffer';

    remote.once('error', (e) => {
      log('console upstream error', e);
      if (!socket.destroyed) reject(502, 'Bad Gateway');
    });
    remote.once('open', () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        const timer = setTimeout(() => client.close(4000, 'Session time limit reached'), MAX_SESSION_MS);
        client.on('message', (data, isBinary) => remote.readyState === WebSocket.OPEN && remote.send(data, { binary: isBinary }));
        remote.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
        const closeBoth = () => {
          clearTimeout(timer);
          if (client.readyState === WebSocket.OPEN) client.close();
          if (remote.readyState === WebSocket.OPEN) remote.close();
        };
        client.on('close', closeBoth);
        remote.on('close', closeBoth);
        client.on('error', closeBoth);
        remote.removeAllListeners('error');
        remote.on('error', closeBoth);
      });
    });
  });
  return wss;
}
