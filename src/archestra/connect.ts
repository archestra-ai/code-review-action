import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * A `host:port` the gateway is dialed at instead of its own address: a
 * local tunnel. The gateway's hostname stays the TLS server name, so the
 * certificate is still checked against it. Nothing else is dialed there,
 * and the system resolver is not consulted for the gateway at all.
 */
export interface ConnectTo {
  host: string;
  port: number;
}

const HOST_PORT = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+)):([0-9]{1,5})$/;

/** Parses `host:port` (an IPv6 address in brackets). Null when the form is wrong. */
export function parseConnectTo(raw: string): ConnectTo | null {
  const match = HOST_PORT.exec(raw.trim());
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1] ?? match[2] ?? "", port };
}

/**
 * A fetch whose requests to the gateway's host go to `connectTo`, with the
 * gateway's hostname as the TLS server name. Other hosts are dialed as usual.
 * `tls` adds options for the TLS connection, such as a `ca` for tests.
 */
export function gatewayFetch(
  gatewayUrl: string,
  connectTo: ConnectTo,
  tls: { ca?: string | Buffer } = {},
): typeof fetch {
  const gatewayHost = new URL(gatewayUrl).hostname;
  const connect = buildConnector({ ...tls });
  const agent = new Agent({
    connect: (options, callback) => {
      if (options.hostname !== gatewayHost) return connect(options, callback);
      // undici dials `hostname`; the gateway's name stays the TLS server name, so the
      // certificate is checked against it, not against the tunnel's address.
      return connect(
        { ...options, hostname: connectTo.host, host: connectTo.host, port: String(connectTo.port), servername: gatewayHost },
        callback,
      );
    },
  });
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    })) as unknown as typeof fetch;
}
