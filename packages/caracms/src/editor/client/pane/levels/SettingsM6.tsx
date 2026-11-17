/**
 * Site Settings' publish-time keys (M6 Decision 14; the mockup's #settings-m6), after
 * Editor branding. Unlike the sections above they act on the live site.
 *
 * - **Default SEO**: the defaults (`seo`): a title (the home page's, and the
 *   fallback's brand), a description, a share image with no alt input. M5a's soft limits.
 * - **Google tag** (`googleTag`, Decision 16): one ID, checked as it's typed with the
 *   server's own rule (seo.ts → googleTagKind). A pasted Google script, or anything else
 *   with an ID in it, offers "Use G-…" (googleTagIn); anything that isn't an ID says
 *   nothing goes on the site.
 * - **Forms** (review gaps, Decision 9; was Form emails): a group per form (FormWords.tsx), its
 *   words (`formWords`) first, then who gets its emails (`formRecipients`), one list per form. Addresses are trimmed, a duplicate isn't added, and an invalid one is
 *   kept as typed with an amber "Gets no email" (the email skips it, as the server's
 *   check does: rules.ts → looksLikeEmail). Removing one has Undo.
 * - **Redirects** (`redirects`, pre-M7 item 8): each old address and where it goes, removable.
 */
import { useState } from 'react';
import { looksLikeEmail } from '../../../../forms/rules.ts';
import { parseRedirects, redirectTargetProblem, type Redirect } from '../../../../redirects.ts';
import { sameAddress } from '../../../../slug.ts';
import { googleTagIn, googleTagKind, SEO_DESCRIPTION_SOFT_LIMIT, SEO_TITLE_SOFT_LIMIT } from '../../../../seo.ts';
import { useEditor, useStore } from '../../context.tsx';
import { useHost, useWarningContext } from '../../fields/host.tsx';
import { DESC_WHY, ShareImage, SoftText, TITLE_WHY } from '../../fields/SeoGroup.tsx';
import { Icon } from '../../shell/Icons.tsx';
import type { EditorForm } from '../../../types.ts';
import { FormsSection } from './FormWords.tsx';

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function SettingsM6({ data }: { data: Record<string, unknown> }) {
	const editor = useEditor();
	const host = useHost();
	const brand = useStore(editor.brand, (b) => b.name);
	const seo = asObject(data.seo);
	const name = str(asObject(data.brand).name).trim() || brand;
	return (
		<>
			<section className="set-sec" data-sec="seo">
				<h3>Default SEO</h3>
				<p className="lead">Defaults for pages that don’t set their own.</p>
				<SoftText
					scope={host.scope}
					name="seo.title"
					label="Default title"
					value={str(seo.title)}
					max={SEO_TITLE_SOFT_LIMIT}
					placeholder={name}
					help={`Blank is “${name}”. Other pages show their own title, then “· ${name}”.`}
					overWhy={TITLE_WHY}
					disabled={host.readOnly}
					onChange={(v) => host.set('seo.title', v)}
				/>
				<SoftText
					scope={host.scope}
					name="seo.description"
					label="Default description"
					value={str(seo.description)}
					max={SEO_DESCRIPTION_SOFT_LIMIT}
					multiline
					overWhy={DESC_WHY}
					disabled={host.readOnly}
					onChange={(v) => host.set('seo.description', v.replace(/\n+/g, ' '))}
				/>
				<ShareImage name="seo.image" label="Default share image" value={seo.image ?? null} help="1200 × 630." />
			</section>
			<GoogleTag value={str(data.googleTag)} />
			{/* Review gaps (Decision 9): Form emails became Forms, a group per form, its words, then its emails. */}
			<FormsSection data={data} recipients={(form) => <Recipients form={form} list={recipientsOf(data, form.id)} />} />
			<Redirects list={parseRedirects(data.redirects)} />
		</>
	);
}

/**
 * Pre-M7 item 8: the redirects that changing a page's address adds (`redirects`), each
 * "from, to", removable with Undo. One whose old address has a page again (it shows
 * instead), or whose new one has nothing (redirectTargetProblem: a page, a file in the
 * library, a route of the site's own code), says so on a warning wash.
 */
function Redirects({ list }: { list: Redirect[] }) {
	const editor = useEditor();
	const host = useHost();
	const documents = useStore(editor.documents);
	const context = useWarningContext();
	const has = (url: string) => documents.some((d) => d.url !== null && sameAddress(d.url) === sameAddress(url));

	return (
		<section className="set-sec" data-sec="redirects">
			<h3>Redirects</h3>
			<p className="lead">Old addresses that send visitors to new ones.</p>
			{list.length ? (
				<div className="eds" data-path="redirects">
					{list.map((r, i) => {
						const why = has(r.from) ? 'A page is at this address now, so the page shows instead.' : redirectTargetProblem(r.to, context);
						return (
							<div key={`${i}:${r.from}`} className={`ed${why ? ' is-confirm' : ''}`} data-redirect={r.from}>
								<span className="tile" aria-hidden="true">
									<Icon name="arrow-r" size="sm" />
								</span>
								<span className="t">
									<b>{r.from}</b>
									<small>
										to <span className="mono">{r.to}</span>
									</small>
								</span>
								<button type="button" className="ib" aria-label={`Remove the redirect from ${r.from}`} disabled={host.readOnly} onClick={() => host.removeItem('redirects', i, `Removed the redirect from ${r.from}`)}>
									<Icon name="x" size="sm" />
								</button>
								{why ? (
									<div className="ed-q" data-why="redirect">
										{why}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			) : (
				<p className="field-help">None yet.</p>
			)}
		</section>
	);
}

const recipientsOf = (data: Record<string, unknown>, id: string): string[] => {
	const list = asObject(data.formRecipients)[id];
	return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
};

/** What the tag field says under it, by the server's own rule (googleTagKind), as it's typed. */
export function googleTagMessage(raw: string): { bad: boolean; text: string; kind: 'blank' | 'ok' | 'bad'; fix: string | null } {
	const v = raw.trim();
	if (!v) return { bad: false, kind: 'blank', text: 'Blank: the site has no tag.', fix: null };
	const kind = googleTagKind(v);
	if (kind) return { bad: false, kind: 'ok', text: `${kind === 'gtm' ? 'Loads Google Tag Manager' : 'Loads Google Analytics'} on the live site`, fix: null };
	const fix = googleTagIn(v);
	const text = /<script|googletagmanager|gtag\(/i.test(v)
		? 'Paste only the ID (G-… or GTM-…), not the script.'
		: /^UA-/i.test(v)
			? 'UA- IDs are Universal Analytics, which Google has switched off. Use the G- ID from Google Analytics 4.'
			: 'IDs start G- or GTM-.';
	return { bad: true, kind: 'bad', text, fix };
}

function GoogleTag({ value }: { value: string }) {
	const host = useHost();
	const msg = googleTagMessage(value);
	return (
		<section className="set-sec" data-sec="gtag">
			<h3>Google tag</h3>
			<p className="lead">Live site only.</p>
			<div className="field gtag" data-field="googleTag" data-ff="googleTag">
				<div className="field-head">
					<label htmlFor="set-gtag">Tag ID</label>
				</div>
				<input
					className="input mono"
					id="set-gtag"
					data-path="googleTag"
					value={value}
					placeholder="G-XXXXXXXXXX or GTM-XXXXXXX"
					autoComplete="off"
					spellCheck={false}
					aria-describedby="gtag-w"
					aria-invalid={msg.bad ? 'true' : undefined}
					disabled={host.readOnly}
					onChange={(e) => host.set('googleTag', e.target.value.replace(/\n+/g, ' '))}
				/>
				<div id="gtag-w" data-gtag={msg.kind}>
					{msg.kind === 'blank' ? (
						<p className="field-help" style={{ marginTop: 'var(--space-1-5)' }}>
							{msg.text}
						</p>
					) : msg.kind === 'ok' ? (
						<p className="field-ok">
							<Icon name="check" size="xs" />
							{msg.text}
						</p>
					) : (
						<p className="field-warn">
							<Icon name="warn" size="sm" />
							<span>
								{msg.text}
								{msg.fix ? (
									<button type="button" className="linkbtn" data-act="gtag-fix" disabled={host.readOnly} onClick={() => host.set('googleTag', msg.fix)}>
										Use {msg.fix}
									</button>
								) : null}
							</span>
						</p>
					)}
				</div>
			</div>
		</section>
	);
}

function Recipients({ form, list }: { form: EditorForm; list: string[] }) {
	const editor = useEditor();
	const host = useHost();
	const [adding, setAdding] = useState('');
	const [why, setWhy] = useState('');
	const n = list.filter(looksLikeEmail).length;
	const path = `formRecipients.${form.id}`;
	const typed = adding.trim();
	// Checked as it's typed: once it has an @, an address that won't get email says so before it's added.
	const typedBad = typed.includes('@') && !looksLikeEmail(typed);
	const add = () => {
		if (!typed || host.readOnly) return;
		if (list.some((x) => x.trim().toLowerCase() === typed.toLowerCase())) {
			setWhy(`${typed} is already on the list.`);
			setAdding('');
			return;
		}
		host.set(path, [...list, typed]);
		setAdding('');
		setWhy('');
		editor.announce(looksLikeEmail(typed) ? `Added ${typed}.` : `Added ${typed}. It isn't a whole email address, so it gets no email.`);
	};
	return (
		<div className="field rcpt" data-field={`rcpt-${form.id}`} data-ff={path}>
			<div className="field-head">
				<span className="field-label">Who gets its emails</span>
				<span className="field-meta">{n ? `${n} address${n === 1 ? '' : 'es'}` : 'No one'}</span>
			</div>
			<p className="field-help">Every message is also kept in Submissions.</p>
			{list.length ? (
				<div className="eds" data-path={path}>
					{list.map((value, i) => {
						const bad = !looksLikeEmail(value);
						return (
							<div key={`${i}:${value}`} className={`ed${bad ? ' is-confirm' : ''}`} data-recipient={value} data-warned={bad ? '' : undefined}>
								<span className="tile" aria-hidden="true">
									<Icon name={bad ? 'warn' : 'mail'} size="sm" />
								</span>
								<span className="t">
									<b>{value}</b>
									{bad ? <small style={{ color: 'var(--status-warning)' }}>Gets no email</small> : <small>Gets every message</small>}
								</span>
								<button type="button" className="ib" aria-label={`Remove ${value}`} disabled={host.readOnly} onClick={() => host.removeItem(path, i, `Removed ${value}`)}>
									<Icon name="x" size="sm" />
								</button>
								{bad ? (
									<div className="ed-q" style={{ color: 'var(--status-warning)' }} data-why="recipient">
										Not a full address; gets no email.
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			) : (
				<div className="list-empty">No one yet.</div>
			)}
			<form
				className="ed-add"
				data-form="rcpt"
				data-fid={form.id}
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<input
					className="input"
					data-rcpt={form.id}
					value={adding}
					placeholder="name@example.com"
					aria-label={`Add an address for the ${form.label} form’s email`}
					autoComplete="off"
					spellCheck={false}
					aria-describedby={typedBad ? `rcpt-${form.id}-w` : undefined}
					onChange={(e) => {
						setAdding(e.target.value);
						if (why) setWhy('');
					}}
				/>
				<button className="btn" type="submit">
					Add
				</button>
			</form>
			{typedBad ? (
				<p className="field-warn" id={`rcpt-${form.id}-w`}>
					<Icon name="warn" size="sm" />
					<span>That isn’t a whole email address yet, so it would get no email.</span>
				</p>
			) : why ? (
				<p className="field-warn quiet">
					<Icon name="check" size="sm" />
					<span>{why}</span>
				</p>
			) : null}
		</div>
	);
}
