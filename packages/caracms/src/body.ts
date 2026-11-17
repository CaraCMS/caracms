/**
 * Reading a request's body under a cap (caracms-cloud adversarial review, finding 10). The
 * bytes are counted as they're read and the read stops the moment they pass the cap,
 * whatever `Content-Length` said or whether it was sent at all (a chunked body has none),
 * so no route buffers more than its cap plus one chunk. A `Content-Length` over the cap is
 * refused before a byte is read. The media upload and the forms endpoint read this way
 * (M5b Decision 6); so do the webhook, sign-in and every editor write route since finding 10.
 */

export interface CappedBody {
	ok: true;
	bytes: Uint8Array;
}
export interface OverCap {
	ok: false;
	/** The size, when the request said it (Content-Length); null when the read was stopped without knowing. */
	size: number | null;
}

/** Read a request's body, stopping as soon as it passes `cap` bytes. */
export async function readCapped(request: Request, cap: number): Promise<CappedBody | OverCap> {
	const declared = Number(request.headers.get('content-length') ?? NaN);
	const said = Number.isFinite(declared) && declared >= 0 ? declared : null;
	if (said !== null && said > cap) {
		await request.body?.cancel().catch(() => {});
		return { ok: false, size: said };
	}
	const reader = request.body?.getReader();
	if (!reader) return { ok: true, bytes: new Uint8Array(0) };
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel().catch(() => {});
			return { ok: false, size: said !== null && said > total ? said : null };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.byteLength;
	}
	return { ok: true, bytes };
}

/** The body as UTF-8 text, or null when it passes `cap` bytes (the route answers its own 413). */
export async function readCappedText(request: Request, cap: number): Promise<string | null> {
	const read = await readCapped(request, cap);
	return read.ok ? new TextDecoder().decode(read.bytes) : null;
}
