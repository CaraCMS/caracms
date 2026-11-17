// The built starter (Phase 1 → Verify 1; M7), built from its own pinned content (helpers/dist.ts,
// test/fixtures/content, M7 Decision 2).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { listDocuments } from 'caracms/content';
import { builtRoot, client, clientFiles, FAKE_MEDIA_ENV, htmlFor, readHtml, site, SITE_URL } from './helpers/dist.ts';
import { count } from './helpers/render.ts';

describe('the built demo', async () => {
	const entries = (await listDocuments(site)).filter((e) => !e.warning && e.url !== null);
	const urls = entries.map((e) => e.url!);
	// M7 adds src/pages/404.astro: a built 404.html that is no document's page (so it's not counted among the pages).
	// Posts and tags (Decision 18): nor is a paged listing's `<page>/page/<n>`.
	const PAGED = /(^|\/)page\/\d+\/index\.html$/;
	const html = clientFiles().filter((f) => f.endsWith('.html') && f !== '404.html' && !PAGED.test(f));

	test('the demo has the pages and posts the checklist lists', () => {
		assert.deepEqual(urls.sort(), [
			'/',
			'/about',
			'/about/team',
			'/contact',
			'/faq',
			'/field-notes',
			'/journal',
			'/journal/a-day-on-the-ferry',
			'/journal/a-mark-for-the-bakery',
			'/journal/a-new-home-for-caracms',
			'/journal/a-new-intern',
			'/journal/a-site-for-weekend-bikes',
			'/journal/a-studio-open-day',
			'/journal/a-summer-workshop',
			'/journal/an-identity-for-tiny-publisher',
			'/journal/back-at-the-ridge',
			'/journal/choosing-a-text-face',
			'/journal/letters-from-the-quay',
			'/journal/notes-from-the-ridge',
			'/journal/paper-samples-from-cork',
			'/journal/posters-for-the-film-studio',
			'/journal/proofing-by-hand',
			'/journal/rebuilding-our-own-site',
			'/journal/small-sites-that-stay-fast',
			'/journal/the-autumn-print-run',
			'/journal/the-first-week-at-the-mill',
			'/journal/the-kitchen-pottery-labels',
			'/journal/the-studio-in-winter',
			'/journal/things-we-keep-on-the-wall',
			'/journal/type-that-holds-its-lines',
			'/journal/widows-orphans-and-phones',
			'/privacy',
			'/services/branding',
			'/services/websites',
			'/studio/visit',
			'/tags/field',
			'/tags/identity',
			'/tags/print',
			'/tags/studio',
			'/tags/type',
			'/tags/web',
			'/work',
			'/work/high-street-coffee',
			'/work/kitchen-pottery',
			'/work/local-travel',
			'/work/nature-films',
			'/work/oak-furniture',
			'/work/sourdough-bakery',
			'/work/tiny-publisher',
			'/work/weekend-bikes',
		]);
	});

	test('M5a: eight case studies at /work/<slug>, each with its heading as the page\'s one h1 and its related work', () => {
		const cases = urls.filter((u) => u.startsWith('/work/'));
		assert.equal(cases.length, 8);
		for (const url of cases) {
			const h = readHtml(url);
			assert.equal(count(h, /<h1[\s>]/g), 1, url);
			// M7: the kicker is the eyebrow line above the heading (was `case-kicker`).
			assert.match(h, /<p class="eyebrow[^"]*"><span data-cms-fixed>Case study<\/span> · /, url);
		}
		assert.match(readHtml('/work/high-street-coffee'), /Related work<\/h2><ul[^>]*><li[^>]*><a class="link" href="\/work\/tiny-publisher"/);
		assert.match(readHtml('/work/high-street-coffee'), /<h2 id="from-the-harbour-wall-outward">From the harbour wall<br>outward<\/h2>/);
	});

	test('M7 Decision 12, Acceptance 25: the shared call to action ends Home, About, Work and Contact, and no other page', () => {
		const cta = /<a href="\/contact" class="btn btn--primary">Start a project<\/a>/;
		for (const url of urls) assert.equal(cta.test(readHtml(url)), ['/', '/about', '/work', '/contact'].includes(url), url);
		// Edit in context, Decision 16: the footer is a shared block now, every page's by its slot, never a page's block.
		for (const url of urls) assert.equal((readHtml(url).match(/data-site-footer/g) ?? []).length, 1, url);
	});

	test('M5a: the case-study lists read the collection, in Site order (review gaps Decision 5a: Featured on Home, In order on Work)', () => {
		// A card with a cover has its <img> first (M5b).
		const cards = (url: string) => [...readHtml(url).matchAll(/<a class="case-card[^"]*" href="(\/work\/[^"]+)"/g)].map((m) => m[1]);
		// The pinned Site Settings holds a hand order that isn't the launch order (its first is Tiny publisher, launched 2025):
		// Featured keeps its filter (three featured), In order takes the first six, and the last two leave the grid.
		assert.deepEqual(cards('/'), ['/work/tiny-publisher', '/work/kitchen-pottery', '/work/local-travel']);
		assert.deepEqual(cards('/work'), ['/work/tiny-publisher', '/work/kitchen-pottery', '/work/local-travel', '/work/nature-films', '/work/oak-furniture', '/work/high-street-coffee']);
	});

	test('every page and post exists at its path, /services/branding included, and no /services', () => {
		for (const url of urls) assert.ok(existsSync(htmlFor(url)), `${url} is missing`);
		assert.ok(existsSync(htmlFor('/services/branding')));
		assert.equal(existsSync(htmlFor('/services')), false);
		assert.equal(html.length, urls.length, `unexpected pages: ${html.join(', ')}`);
		assert.ok(existsSync(`${client}/sitemap.xml`), 'M6: the sitemap');
	});

	test('M6 Decision 17, M7 Decisions 17 and 20: every page has the motion and menu module and the Google tag (it\'s set in Site Settings); the form\'s page adds its one inline script; no data-cms-*, no contenteditable in any built page', () => {
		// M7: Page.astro ships one module on every page, the motion setup and the header's menu.
		const page = /^<script type="module" src="\/_astro\/Page\.astro_astro_type_script_index_0_lang\.[\w-]+\.js">$/;
		const tag = [/^<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-TEST000001">$/, /^<script>$/];
		const own: Record<string, RegExp[]> = {
			// The form's script is small enough that Astro inlines it.
			'contact/index.html': [...tag, page, /^<script type="module">$/],
		};
		for (const file of html) {
			const h = readHtml(`/${file.replace(/(^|\/)index\.html$/, '')}`);
			const scripts = [...h.matchAll(/<script[^>]*>/gi)].map((m) => m[0]);
			const expected = own[file] ?? [...tag, page];
			assert.equal(scripts.length, expected.length, `${file}: ${scripts.join(' ')}`);
			for (const re of expected) assert.ok(scripts.some((s) => re.test(s)), `${file}: ${re}`);
			if (file === 'contact/index.html') assert.match(h, /<script type="module">[^<]*form\[data-caracms-form\][^<]*<\/script>/, 'the form\'s own script');
			// data-cms-fixed is the site's own attribute (words it accepts as code, for `caracms audit`), so it ships; every other marker is refused.
			assert.equal(count(h, /data-cms-(?!fixed\b)/g), 0, `${file}: data-cms-*`);
			assert.equal(count(h, /contenteditable/gi), 0, `${file}: contenteditable`);
			assert.equal(count(h, /data-preview/g), 0, `${file}: data-preview (preview renders only)`);
		}
	});

	test('no JavaScript in the client output but the editor\'s own (/admin, M4 Decision 1), the motion setup\'s (M7 Decision 20: Page\'s script and the chunks it imports) and the player\'s (M5b: its click script and Mux Player\'s chunks); the form\'s is inline (M6)', () => {
		const all = clientFiles().filter((f) => /\.m?js$/.test(f));
		const editor = all.filter((f) => /^_astro\/admin\.astro_/.test(f));
		const player = all.filter((f) => /^_astro\/MediaPlayer\.astro_astro_type_script_/.test(f));
		const motion = all.filter((f) => /^_astro\/Page\.astro_astro_type_script_/.test(f));
		assert.equal(editor.length, 1, all.join(', '));
		assert.equal(player.length, 1, all.join(', '));
		assert.equal(motion.length, 1, all.join(', '));
		// Everything else is a chunk one of the three entries imports: the editor's lazy ones (M5b: UpChunk),
		// what the player's script imports on its first click (@mux/mux-player), and the motion setup's libraries.
		const reached = new Set<string>();
		const visit = (file: string) => {
			if (reached.has(file)) return;
			reached.add(file);
			const text = readFileSync(`${client}/${file}`, 'utf8');
			for (const other of all) if (!reached.has(other) && text.includes(other.slice('_astro/'.length))) visit(other);
		};
		[...editor, ...player, ...motion].forEach(visit);
		for (const chunk of all) assert.ok(reached.has(chunk), `${chunk} isn't the editor's, the player's or the motion setup's`);
		const script = readFileSync(`${client}/${player[0]}`, 'utf8');
		// Mux Player is imported on click, never at load.
		assert.match(script, /import\(/);
		// Acceptance 31: the public scripts' own files ship no React.
		for (const f of [...player, ...motion]) assert.doesNotMatch(readFileSync(`${client}/${f}`, 'utf8'), /react-dom|react\.production|__SECRET_INTERNALS/, `${f}: no React on public pages`);
	});

	test('M5b: images are signed, on the ladder, sized, and anchored only where a focal point is set', () => {
		const LADDER = [160, 320, 480, 640, 960, 1280, 1920];
		const { CARACMS_MEDIA_URL: origin, IMGPROXY_KEY: key, IMGPROXY_SALT: salt, S3_BUCKET: bucket } = FAKE_MEDIA_ENV;
		const sign = (path: string) => createHmac('sha256', Buffer.from(key, 'hex')).update(Buffer.from(salt, 'hex')).update(path).digest('base64url');
		const signed = (url: string) => {
			assert.ok(url.startsWith(`${origin}/`), url);
			const rest = url.slice(origin.length + 1);
			const sig = rest.slice(0, rest.indexOf('/'));
			const path = rest.slice(sig.length);
			assert.equal(sig, sign(path), `signature of ${url}`);
			assert.ok(path.includes(`/plain/s3://${bucket}/uploads/`), url);
			return path;
		};
		const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
		const imgs = (url: string) => [...readHtml(url).matchAll(/<img\s[^>]*>/g)].map((m) => m[0].replaceAll('&amp;', '&')).filter((t) => attr(t, 'src')!.startsWith(FAKE_MEDIA_ENV.CARACMS_MEDIA_URL));
		const all = ['/', '/about', '/field-notes'].flatMap(imgs);
		assert.ok(all.length >= 9, String(all.length));
		for (const tag of all) {
			const path = signed(attr(tag, 'src')!);
			assert.ok(attr(tag, 'width') && attr(tag, 'height'), `width/height: ${tag}`);
			if (/\.gif$/.test(path)) {
				assert.equal(attr(tag, 'srcset'), undefined, 'a GIF passes through');
				assert.match(path, /^\/plain\//);
				continue;
			}
			const entries = attr(tag, 'srcset')!.split(', ').map((e) => e.split(' '));
			assert.deepEqual(entries.map(([, w]) => w), LADDER.map((w) => `${w}w`));
			for (const [u] of entries) assert.match(signed(u!), /^\/rs:(fit|fill):\d+:\d+(\/g:fp:[\d.]+:[\d.]+)?\/q:80\/plain\/.+@webp$/);
			assert.ok(attr(tag, 'sizes'), 'a fluid image has sizes');
			const focal = /\/g:fp:([\d.]+):([\d.]+)\//.exec(path);
			const style = attr(tag, 'style') ?? '';
			if (focal) assert.match(style, new RegExp(`object-position: ${Math.round(Number(focal[1]) * 100)}% ${Math.round(Number(focal[2]) * 100)}%`));
			else assert.doesNotMatch(style, /object-position/);
		}
		// Home: the hero's image behind its text fits the band (rs:fit, 100vw), eager and high; the cards are 3:2 and lazy.
		const home = imgs('/');
		assert.match(home[0]!, /rs:fit:1920:0\//);
		assert.match(home[0]!, /sizes="100vw"/);
		assert.match(home[0]!, /loading="eager"/);
		assert.match(home[0]!, /fetchpriority="high"/);
		assert.ok(home.slice(1).every((t) => /rs:fill:1920:1280\//.test(t) && /loading="lazy"/.test(t)), 'the cards: 3:2, lazy');
		// Field notes: text and media at 3:2, the gallery at 4:5 (lazy, one decorative with alt=""), Full-width media full-bleed at 16:9.
		const notes = imgs('/field-notes');
		assert.match(notes[0]!, /rs:fill:1920:1280\/g:fp:/);
		assert.match(notes[0]!, /loading="eager"/, 'the second rendered block is eager');
		assert.doesNotMatch(notes.join(''), /fetchpriority/, 'the first block is a loop: no image is high');
		const gallery = notes.filter((t) => /rs:fill:1280:1600\//.test(t));
		assert.equal(gallery.length, 3);
		assert.ok(gallery.every((t) => /loading="lazy"/.test(t)), 'the gallery is lazy');
		assert.ok(gallery.some((t) => /\salt(=""|\s|>)/.test(t)), 'decorative: alt=""');
		assert.match(notes.at(-1)!, /rs:fill:1920:1080\//);
		assert.match(notes.at(-1)!, /sizes="100vw"/);
		// The hero's clip plays as a loop (the slot is loop-only), muted, with no player code; reduced motion gets the poster.
		const video = /<video[^>]*>.*?<\/video>/s.exec(readHtml('/field-notes'))![0];
		for (const a of ['autoplay', 'muted', 'loop', 'playsinline', 'aria-hidden="true"']) assert.ok(video.includes(a), a);
		assert.match(video, /poster="https:\/\/image\.mux\.com\/[^"]*\/thumbnail\.webp\?width=1920&amp;time=0"/);
		assert.match(video, /<source src="https:\/\/stream\.mux\.com\/[^"]*\/highest\.mp4" type="video\/mp4" media="\(prefers-reduced-motion: no-preference\)">/);
	});

	test('every page has exactly one h1', () => {
		for (const url of urls) assert.equal(count(readHtml(url), /<h1[\s>]/g), 1, url);
	});

	test('the lockup CSS: the container, the unfloored fit, the phone-lines media query at the site\'s width, font-display block', () => {
		// The page's CSS, inline or linked (M5a's blocks made the bundle big enough for Astro to link it).
		const page = readHtml('/about');
		const linked = [...page.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map((m) => readFileSync(`${client}/${m[1]}`, 'utf8'));
		const h = [page, ...linked].join('\n');
		assert.match(h, /\.cms-lockup-set\{[^}]*container-type:inline-size/);
		assert.match(h, /font-size:min\(var\(--cms-size\), calc\(100cqi \/ var\(--longest-line\)\)\)/);
		assert.match(h, new RegExp(`@media \\(width<${site.phoneLinesWidth}px\\)\\{\\.cms-lockup-phone\\{display:block\\}\\.cms-lockup--has-phone>\\.cms-lockup-main\\{display:none\\}\\}`));
		assert.match(h, /font-display:block/);
		assert.match(h, /font-variation-settings:var\(--cms-variation\);font-optical-sizing:none/);
	});

	test('About\'s hero has phone lines: both sets in its one h1', () => {
		const h1 = /<h1[\s\S]*?<\/h1>/.exec(readHtml('/about'))![0];
		assert.match(h1, /cms-lockup--has-phone/);
		assert.equal(count(h1, /cms-lockup-set /g), 2);
	});

	test('M6 Decision 11: no page has a robots meta (the start server sends X-Robots-Tag)', () => {
		for (const url of urls) assert.doesNotMatch(readHtml(url), /<meta name="robots"/, url);
	});

	test('M6 Decisions 3 and 15: every page has a canonical link and og:url on SITE_URL, a title, and the share tags', () => {
		for (const url of urls) {
			const h = readHtml(url);
			assert.equal(count(h, /<title>/g), 1, `${url}: one title`);
			assert.ok(h.includes(`<link rel="canonical" href="${SITE_URL}${url === '/' ? '/' : url}">`), `${url}: canonical`);
			assert.ok(h.includes(`<meta property="og:url" content="${SITE_URL}${url === '/' ? '/' : url}">`), `${url}: og:url`);
			assert.match(h, /<meta name="twitter:card" content="summary_large_image">/, `${url}: Site Settings' default image`);
		}
	});

	test("M6 Acceptance 29: titles: the page's seo.title as written, the home page Site Settings' seo.title, others <title> · <brand>", () => {
		const title = (url: string) => /<title>([^<]*)<\/title>/.exec(readHtml(url))![1];
		assert.equal(title('/contact'), 'Contact CaraCMS');
		assert.equal(title('/'), 'CaraCMS — a small design studio');
		assert.equal(title('/about'), 'About · CaraCMS');
		assert.match(readHtml('/contact'), /<meta name="description" content="Tell CaraCMS about your project and we will get back to you within a working day\.">/);
		assert.match(readHtml('/about'), /<meta name="description" content="A small design studio in the hills, making brands, websites and print that hold together at every size\.">/, "Site Settings' default");
	});

	test('M6 Acceptance 31: the share image is a signed 1200 × 630 rs:fill (Site Settings\' default, with no focal point)', () => {
		const { CARACMS_MEDIA_URL: origin, IMGPROXY_KEY: key, IMGPROXY_SALT: salt } = FAKE_MEDIA_ENV;
		const tag = /<meta property="og:image" content="([^"]+)">/.exec(readHtml('/contact'))![1]!.replaceAll('&amp;', '&');
		const rest = tag.slice(origin.length + 1);
		const sig = rest.slice(0, rest.indexOf('/'));
		const path = rest.slice(sig.length);
		assert.equal(sig, createHmac('sha256', Buffer.from(key, 'hex')).update(Buffer.from(salt, 'hex')).update(path).digest('base64url'));
		assert.match(path, /^\/rs:fill:1200:630\/q:80\/plain\/s3:\/\/test-media\/uploads\/e4c45074933b\/studio-window\.jpg@webp$/);
		assert.match(readHtml('/contact'), /<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">/);
	});

	test('M6 Acceptance 37: the sitemap lists every page, post and case study on SITE_URL, and nothing else', () => {
		const xml = readFileSync(`${client}/sitemap.xml`, 'utf8');
		const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
		assert.deepEqual(locs.sort(), urls.map((u) => `${SITE_URL}${u}`).sort());
	});

	test('M6 Decision 17: the Contact form posts without JavaScript, files included', () => {
		const form = /<form[^>]*data-caracms-form="contact"[^>]*>[\s\S]*?<\/form>/.exec(readHtml('/contact'))![0];
		assert.match(form, /action="\/_caracms\/form"/);
		assert.match(form, /method="post"/);
		assert.match(form, /enctype="multipart\/form-data"/);
		assert.match(form, /<input type="hidden" name="form" value="contact">/);
		assert.match(form, /<input type="hidden" name="return" value="\/contact\/?">/);
		assert.match(form, /<input type="text" name="fax" tabindex="-1" autocomplete="off">/);
		assert.match(form, /<input id="cms-form-contact-email" type="email" name="email" required/);
		assert.match(form, /<input id="cms-form-contact-files" type="file" name="files" multiple accept="\.jpg,/);
		assert.match(form, /<select id="cms-form-contact-kind" name="kind" required/);
		assert.doesNotMatch(form, /cms-form-turnstile/, 'no Turnstile without its site key at build');
		assert.doesNotMatch(form, /inert/);
	});
});

describe('posts and tags, built (Decisions 6–11, 17; Acceptance 2–4, 7–11, 18, 21)', () => {
	// The pinned posts, in the post order worked out here on its own: newest date first, undated last, ties by title.
	const posts = readdirSync(`${builtRoot}/content/journal`)
		.filter((f) => f.endsWith('.json'))
		.map((f) => {
			const d = JSON.parse(readFileSync(`${builtRoot}/content/journal/${f}`, 'utf8')) as { title: string; date?: string; tags?: string[] };
			return { slug: f.slice(0, -5), title: d.title, date: d.date ?? '', tags: d.tags ?? [] };
		})
		.sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : !a.date ? 1 : !b.date ? -1 : b.date.localeCompare(a.date)));
	const order = posts.map((p) => p.slug);
	const cards = (url: string) => [...readHtml(url).matchAll(/<a class="post-card[^"]*" href="\/journal\/([^"]+)"/g)].map((m) => m[1]);
	const title = (url: string) => /<title>([^<]*)<\/title>/.exec(readHtml(url))![1];

	test('the pinned journal has 24 posts, one undated, and a tie on one day', () => {
		assert.equal(posts.length, 24);
		assert.equal(posts.filter((p) => !p.date).length, 1);
		assert.ok(posts.some((p, i) => p.date && posts[i + 1]?.date === p.date), 'two posts share a day');
	});

	test('Home: the latest three posts as cards, in the post order', () => {
		assert.deepEqual(cards('/'), order.slice(0, 3));
	});

	test('the journal: ten a page at /journal, /journal/page/2 and /journal/page/3; no /page/1 or /page/4; the undated post last', () => {
		assert.deepEqual(cards('/journal'), order.slice(0, 10));
		assert.deepEqual(cards('/journal/page/2'), order.slice(10, 20));
		assert.deepEqual(cards('/journal/page/3'), order.slice(20));
		assert.equal(cards('/journal/page/3').at(-1), posts.find((p) => !p.date)!.slug);
		assert.equal(existsSync(htmlFor('/journal/page/1')), false);
		assert.equal(existsSync(htmlFor('/journal/page/4')), false);
		assert.equal(existsSync(`${client}/page`), false, 'Home is Latest: no /page/');
	});

	test('the pager: "Older posts" only on page 1, both on page 2, "Newer posts" only on page 3, and "Page n of 3"; plain links', () => {
		const pager = (url: string) => /<nav class="pager[^>]*>([\s\S]*?)<\/nav>/.exec(readHtml(url))![1]!;
		const links = (url: string) => [...pager(url).matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
		assert.deepEqual(links('/journal'), ['Older posts /journal/page/2']);
		assert.deepEqual(links('/journal/page/2'), ['Newer posts /journal', 'Older posts /journal/page/3']);
		assert.deepEqual(links('/journal/page/3'), ['Newer posts /journal/page/2']);
		for (const n of [1, 2, 3]) assert.match(pager(n === 1 ? '/journal' : `/journal/page/${n}`), new RegExp(`Page ${n} of 3`));
	});

	test('page 2 onwards: " — page N" in the title, its own canonical link, and the same scripts as page 1', () => {
		assert.equal(title('/journal'), 'Journal · CaraCMS');
		assert.equal(title('/journal/page/2'), 'Journal — page 2 · CaraCMS');
		assert.equal(title('/journal/page/3'), 'Journal — page 3 · CaraCMS');
		assert.match(readHtml('/journal/page/2'), new RegExp(`<link rel="canonical" href="${SITE_URL}/journal/page/2"`));
		const scripts = (url: string) => [...readHtml(url).matchAll(/<script[^>]*>/g)].map((m) => m[0]);
		assert.deepEqual(scripts('/journal/page/2'), scripts('/journal'));
		assert.equal(count(readHtml('/journal/page/2'), /data-cms-(?!fixed\b)|contenteditable/g), 0);
	});

	test("a tag's page: its title as the h1, its description, and only its posts, in the post order", () => {
		for (const f of readdirSync(`${builtRoot}/content/tags`).filter((n) => n.endsWith('.json'))) {
			const slug = f.slice(0, -5);
			const tag = JSON.parse(readFileSync(`${builtRoot}/content/tags/${f}`, 'utf8')) as { title: string; description?: string };
			const h = readHtml(`/tags/${slug}`);
			assert.match(h, new RegExp(`<h1[^>]*>${tag.title}</h1>`), slug);
			if (tag.description) assert.ok(h.includes(tag.description.replaceAll('&', '&amp;')) || h.includes(tag.description), `${slug}: its description`);
			assert.deepEqual(cards(`/tags/${slug}`), posts.filter((p) => p.tags.includes(slug)).map((p) => p.slug), slug);
		}
	});

	test("a post: its date and tags above its blocks, and its older and newer neighbours at the bottom", () => {
		const at = 5;
		const post = posts[at]!;
		const h = readHtml(`/journal/${post.slug}`);
		const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(h)![1]!;
		assert.match(main, new RegExp(`^\\s*<div[^>]*><time[^>]*datetime="${post.date}"`), 'the date comes first');
		for (const tag of post.tags) assert.match(main, new RegExp(`<a class="link"[^>]*href="/tags/${tag}"`), tag);
		assert.match(h, new RegExp(`rel="prev" href="/journal/${order[at + 1]}"`), 'older: the next one down');
		assert.match(h, new RegExp(`rel="next" href="/journal/${order[at - 1]}"`), 'newer: the one above');
		const newest = readHtml(`/journal/${order[0]}`);
		assert.doesNotMatch(newest, /rel="next" href="\/journal\//, 'the newest has no newer');
		const last = readHtml(`/journal/${order.at(-1)}`);
		assert.doesNotMatch(last, /rel="prev" href="\/journal\//, 'the last (undated) has no older');
		assert.match(readHtml(`/journal/${order.at(-2)}`), new RegExp(`rel="prev" href="/journal/${order.at(-1)}"`), 'the undated post follows the oldest dated one');
		assert.doesNotMatch(last, /<time/, 'an undated post shows no date');
	});

	test('the menu has Journal', () => {
		assert.match(readHtml('/'), /<a [^>]*href="\/journal"[^>]*>Journal<\/a>/);
	});
});
