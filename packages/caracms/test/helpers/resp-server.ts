/**
 * A minimal Redis for the client's tests (there's no redis-server on the dev Mac): a
 * TCP server that speaks just enough RESP for ioredis's handshake (INFO's ready
 * check, CLIENT SETINFO, SELECT) and GET, MGET, SET (PX, NX), DEL, INCR, SCAN (one page,
 * `*` globs), PING and QUIT. It can be
 * started late on a fixed port, so the client first sees connections refused, as a
 * sleeping Railway Redis gives them (M1 → R2).
 */
import { createServer, type Server, type Socket } from 'node:net';

/** A port nothing listens on (yet). */
export async function freePort(): Promise<number> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));
	return port;
}

export interface RespServer {
	/** Start listening (resolves once it does). */
	listen(): Promise<void>;
	close(): Promise<void>;
	/** Every command received, upper-cased name first. */
	commands: string[][];
	/** Connections open right now. */
	open(): number;
	/** Cut every open connection from the server's side (a Redis that dropped, or restarted). The server keeps listening. */
	dropAll(): void;
	/** Connections accepted so far, and when (Date.now()). */
	accepted: number[];
}

/**
 * `onCommand` sees each command before it is answered: 'drop' cuts that connection
 * without a reply (the command was sent, and its answer never came), 'silent' reads
 * it and says nothing (a Redis that stopped answering).
 */
export function respServer(port: number, onCommand?: (args: string[]) => 'drop' | 'silent' | undefined): RespServer {
	const data = new Map<string, { value: string; expires: number | null }>();
	const commands: string[][] = [];
	const sockets = new Set<Socket>();
	const accepted: number[] = [];
	let server: Server | null = null;

	const bulk = (s: string | null) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
	const reply = (args: string[]): string => {
		const [name = '', ...rest] = args;
		const cmd = name.toUpperCase();
		commands.push([cmd, ...rest]);
		const live = (k: string) => {
			const v = data.get(k);
			if (v && v.expires !== null && v.expires <= Date.now()) data.delete(k);
			return data.get(k) ?? null;
		};
		switch (cmd) {
			case 'PING':
				return '+PONG\r\n';
			case 'INFO':
				return bulk('# Server\r\nredis_version:7.2.0\r\n# Persistence\r\nloading:0\r\n');
			case 'CLIENT':
			case 'SELECT':
				return '+OK\r\n';
			case 'GET':
				return bulk(live(rest[0]!)?.value ?? null);
			case 'SET': {
				const [key, value, ...opts] = rest;
				let expires: number | null = null;
				let nx = false;
				for (let i = 0; i < opts.length; i++) {
					const o = opts[i]!.toUpperCase();
					if (o === 'PX') expires = Date.now() + Number(opts[++i]);
					else if (o === 'NX') nx = true;
				}
				if (nx && live(key!)) return '$-1\r\n';
				data.set(key!, { value: value!, expires });
				return '+OK\r\n';
			}
			case 'DEL':
				return `:${rest.filter((k) => live(k) && data.delete(k)).length}\r\n`;
			case 'MGET':
				return `*${rest.length}\r\n${rest.map((k) => bulk(live(k)?.value ?? null)).join('')}`;
			case 'INCR': {
				const v = live(rest[0]!);
				const n = Number(v?.value ?? 0) + 1;
				data.set(rest[0]!, { value: String(n), expires: v?.expires ?? null });
				return `:${n}\r\n`;
			}
			case 'SCAN': {
				const match = rest.findIndex((a) => a.toUpperCase() === 'MATCH');
				const re = new RegExp(`^${(match === -1 ? '*' : rest[match + 1]!).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
				const keys = [...data.keys()].filter((k) => live(k) && re.test(k));
				return `*2\r\n${bulk('0')}*${keys.length}\r\n${keys.map(bulk).join('')}`;
			}
			case 'QUIT':
				return '+OK\r\n';
			default:
				return `-ERR unknown command '${name}'\r\n`;
		}
	};

	/** Parse complete RESP arrays of bulk strings from the front of `buf`. */
	const parse = (buf: Buffer): { commands: string[][]; rest: Buffer } => {
		const out: string[][] = [];
		let pos = 0;
		for (;;) {
			const start = pos;
			const line = (from: number) => {
				const end = buf.indexOf('\r\n', from);
				return end === -1 ? null : { text: buf.subarray(from, end).toString(), next: end + 2 };
			};
			const head = line(pos);
			if (!head || head.text[0] !== '*') return { commands: out, rest: buf.subarray(start) };
			const n = Number(head.text.slice(1));
			pos = head.next;
			const args: string[] = [];
			for (let i = 0; i < n; i++) {
				const len = line(pos);
				if (!len) return { commands: out, rest: buf.subarray(start) };
				const size = Number(len.text.slice(1));
				if (buf.length < len.next + size + 2) return { commands: out, rest: buf.subarray(start) };
				args.push(buf.subarray(len.next, len.next + size).toString());
				pos = len.next + size + 2;
			}
			out.push(args);
		}
	};

	return {
		commands,
		accepted,
		open: () => sockets.size,
		dropAll() {
			for (const s of sockets) s.destroy();
		},
		listen() {
			server = createServer((socket) => {
				sockets.add(socket);
				accepted.push(Date.now());
				socket.on('close', () => sockets.delete(socket));
				socket.on('error', () => {});
				let pending = Buffer.alloc(0);
				socket.on('data', (chunk) => {
					const parsed = parse(Buffer.concat([pending, chunk]));
					pending = Buffer.from(parsed.rest);
					for (const args of parsed.commands) {
						const verdict = onCommand?.(args);
						if (verdict === 'drop') {
							commands.push([args[0]!.toUpperCase(), ...args.slice(1)]);
							socket.destroy();
							return;
						}
						if (verdict === 'silent') {
							commands.push([args[0]!.toUpperCase(), ...args.slice(1)]);
							continue;
						}
						socket.write(reply(args));
						if (args[0]?.toUpperCase() === 'QUIT') socket.end();
					}
				});
			});
			return new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
		},
		async close() {
			for (const s of sockets) s.destroy();
			if (server) await new Promise<void>((r) => server!.close(() => r()));
		},
	};
}
