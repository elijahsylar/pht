import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

// Where the API listens. Loopback by default: nginx on the same machine is
// the only intended client (see ops/nginx), so nothing else on the network
// should reach the port directly. LISTEN_HOST overrides it for setups that
// need another interface, for example a container. It is not called HOST
// because some shells set that to the machine's name.
export const DEFAULT_LISTEN_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4100;

export interface ListenOptions {
  host: string;
  port: number;
}

export function listenOptions(env: NodeJS.ProcessEnv): ListenOptions {
  return {
    host: env.LISTEN_HOST?.trim() || DEFAULT_LISTEN_HOST,
    port: Number(env.PORT ?? DEFAULT_PORT),
  };
}

// The only place the server is bound (src/index.ts starts it through this),
// so the host is always given. `onListening` gets the address actually bound.
export function startListening(
  app: Express,
  env: NodeJS.ProcessEnv,
  onListening?: (address: AddressInfo) => void,
): Server {
  const { host, port } = listenOptions(env);
  const server = app.listen(port, host, () => onListening?.(server.address() as AddressInfo));
  return server;
}
