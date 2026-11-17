/**
 * Whether the media routes are set up (M5b Decision 5), images and clips apart: **one
 * missing never disables the other**. Read from `process.env` on each request (cheap),
 * so `astro build` needs none of them and the Mux token is first read by the first
 * request that needs it.
 *
 * - **`CARACMS_MEDIA=memory` always wins**: the in-memory bucket and the fake Mux
 *   (memory.ts), whatever else is set, so nothing in a test can touch the real bucket or
 *   Mux. **Refused on a production server**, as `CARACMS_GITHUB=memory` is.
 * - Images need imgproxy's (`CARACMS_MEDIA_URL`, `IMGPROXY_KEY`, `IMGPROXY_SALT`, which
 *   sign the thumbnails) and the bucket's (`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`,
 *   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`). Clips need `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET`.
 * - **On CaraCMS Cloud** (caracms-cloud M3 Decision 19) `CARACMS_CLOUD_KEY` is the images'
 *   one credential: the bucket is the cloud's (cloud-bucket.ts), the signing from the
 *   settings the process holds (../../../media.ts).
 * - **And the clips' (caracms-cloud M4.5 Decision 15)**: with the key, clips go through the
 *   cloud's Mux (cloud-mux.ts), and the site's own `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET`
 *   beside it is a problem sentence naming them (one credential, not two).
 * - **With the config's `services`** (caracms-cloud M5 Decision 2) the other mode's variables
 *   are never read (live/services.ts), and a cloud site without its key has neither.
 */
import type { CloudConnection } from '../../../live/cloud.ts';
import { CLOUD_AND_MUX_PROBLEM, OWN_MUX_VARIABLES, readCloudUrl } from '../../../live/mode.ts';
import { bakedServices, CLOUD_KEY_MISSING_PROBLEM, servicesEnv, type Services } from '../../../live/services.ts';
import { cloudMedia, isProductionBuild, readMediaConfig, type MediaSettings } from '../../../media.ts';

type Env = Record<string, string | undefined>;

export interface BucketSettings {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export type ImagesConfig =
	| { kind: 'memory'; signing: MediaSettings }
	| { kind: 's3'; signing: MediaSettings; bucket: BucketSettings }
	| { kind: 'cloud'; signing: MediaSettings; connection: Pick<CloudConnection, 'key' | 'url'> }
	| { kind: 'unset'; message: string; missing: string[] };

export type MuxConfig =
	| { kind: 'memory' }
	| { kind: 'mux'; tokenId: string; tokenSecret: string }
	| { kind: 'cloud'; connection: Pick<CloudConnection, 'key' | 'url'> }
	| { kind: 'unset'; message: string; missing: string[] };

export const MEMORY_IN_PRODUCTION = 'CARACMS_MEDIA=memory is for tests and local runs; a production server never uses the in-memory media.';

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const get = (env: Env, name: string) => {
	const v = env[name]?.trim();
	return v ? v : null;
};
const memory = (env: Env) => get(env, 'CARACMS_MEDIA') === 'memory';

/** The image routes' settings: the bucket, and imgproxy's for the thumbnails. */
export function readImagesConfig(env: Env = process.env, production = isProductionBuild(), services: Services | null = bakedServices()): ImagesConfig {
	env = servicesEnv(env, services);
	if (memory(env)) {
		if (production) return { kind: 'unset', message: MEMORY_IN_PRODUCTION, missing: [] };
		const signing = readMediaConfig(env, production, services);
		if (signing.kind !== 'ready') return { kind: 'unset', message: MEMORY_IN_PRODUCTION, missing: [] };
		return { kind: 'memory', signing: signing.settings };
	}
	if (services === 'cloud' && !get(env, 'CARACMS_CLOUD_KEY')) return { kind: 'unset', message: CLOUD_KEY_MISSING_PROBLEM, missing: [] };
	const signing = readMediaConfig(env, production, services);
	const cloud = cloudMedia(env, services);
	if (cloud) {
		if (signing.kind === 'ready') return { kind: 'cloud', signing: signing.settings, connection: cloud.connection };
		return { kind: 'unset', message: signing.problems.join(' '), missing: [] };
	}
	const missing = signing.kind === 'unset' ? [...signing.missing] : [];
	const problems = signing.kind === 'unset' ? [...signing.problems] : [];
	const need = (name: string) => {
		const v = get(env, name);
		if (!v && !missing.includes(name)) missing.push(name);
		return v ?? '';
	};
	const endpoint = need('S3_ENDPOINT').replace(/\/+$/, '');
	const region = need('S3_REGION');
	const accessKeyId = need('S3_ACCESS_KEY_ID');
	const secretAccessKey = need('S3_SECRET_ACCESS_KEY');
	if (endpoint && !/^https?:\/\/[^/]+$/.test(endpoint)) problems.push(`S3_ENDPOINT must be an origin like https://t3.storageapi.dev (got "${endpoint}").`);
	if (missing.length || problems.length || signing.kind !== 'ready') {
		const sentence = missing.length ? `The media library isn't set up here: set ${list(missing)} to the site's media bucket and imgproxy.` : '';
		return { kind: 'unset', message: [sentence, ...problems].filter(Boolean).join(' '), missing };
	}
	return { kind: 's3', signing: signing.settings, bucket: { endpoint, region, bucket: signing.settings.bucket, accessKeyId, secretAccessKey } };
}

/** The clip routes' settings: the cloud's Mux (the site key), or the site's Mux environment's token. */
export function readMuxConfig(env: Env = process.env, production = isProductionBuild(), services: Services | null = bakedServices()): MuxConfig {
	env = servicesEnv(env, services);
	if (memory(env)) return production ? { kind: 'unset', message: MEMORY_IN_PRODUCTION, missing: [] } : { kind: 'memory' };
	const key = get(env, 'CARACMS_CLOUD_KEY');
	if (services === 'cloud' && !key) return { kind: 'unset', message: CLOUD_KEY_MISSING_PROBLEM, missing: [] };
	if (key) {
		const problems: string[] = [];
		const both = OWN_MUX_VARIABLES.filter((name) => get(env, name));
		if (both.length) problems.push(CLOUD_AND_MUX_PROBLEM(both));
		const url = readCloudUrl(get(env, 'CARACMS_CLOUD_URL'), problems);
		if (problems.length) return { kind: 'unset', message: problems.join(' '), missing: [] };
		return { kind: 'cloud', connection: { key, url } };
	}
	const tokenId = get(env, 'MUX_TOKEN_ID');
	const tokenSecret = get(env, 'MUX_TOKEN_SECRET');
	const missing = [...(tokenId ? [] : ['MUX_TOKEN_ID']), ...(tokenSecret ? [] : ['MUX_TOKEN_SECRET'])];
	if (missing.length) return { kind: 'unset', message: `Video isn't set up here: set ${list(missing)} to the site's Mux environment's token.`, missing };
	return { kind: 'mux', tokenId: tokenId!, tokenSecret: tokenSecret! };
}
