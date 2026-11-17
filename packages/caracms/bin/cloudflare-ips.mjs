// Cloudflare's published IP ranges, from https://www.cloudflare.com/ips-v4/ and
// https://www.cloudflare.com/ips-v6/ (listed at cloudflare.com/ips), fetched 2026-10-24.
//
// The gate (gate.mjs) uses them to tell a request that came through Cloudflare's proxy:
// when the address its IP source gives is in one of these, it takes CF-Connecting-IP
// instead (runs-anywhere spec, Decision 8), but only on the site's own domain: a Worker
// on anyone's account calls from these ranges and can set CF-Connecting-IP to a host's
// own address, so the gate's Host rule (isPlatformHost) is what keeps that out, not this
// list. Cloudflare changes them rarely; a stale list means one shared bucket for a new
// range. To refresh: copy both lists here and change the date above.

export const CLOUDFLARE_IPV4 = [
	'173.245.48.0/20',
	'103.21.244.0/22',
	'103.22.200.0/22',
	'103.31.4.0/22',
	'141.101.64.0/18',
	'108.162.192.0/18',
	'190.93.240.0/20',
	'188.114.96.0/20',
	'197.234.240.0/22',
	'198.41.128.0/17',
	'162.158.0.0/15',
	'104.16.0.0/13',
	'104.24.0.0/14',
	'172.64.0.0/13',
	'131.0.72.0/22',
];

export const CLOUDFLARE_IPV6 = [
	'2400:cb00::/32',
	'2606:4700::/32',
	'2803:f800::/32',
	'2405:b500::/32',
	'2405:8100::/32',
	'2a06:98c0::/29',
	'2c0f:f248::/32',
];
