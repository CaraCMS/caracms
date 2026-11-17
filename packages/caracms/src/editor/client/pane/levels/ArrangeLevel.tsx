/**
 * Arrange pages (Decision 16; the mockup's
 * packages/caracms/test/mockups/arrange-pages.html): the pane while the arrange screen has the stage.
 * Arranging, it lists what's been arranged so far and has Cancel and Review…, off with its
 * reason while a new group is empty or a name is half typed (Decision 9). After Review…,
 * the review: every old → new address, a holder's documents as one count line with a
 * disclosure, the "goes: no pages left" line, the one tick (Decision 3), or the order-only
 * panel (Decision 21); then Back and Apply. A refused Apply shows here, named.
 */
import { useEditor, useStore } from '../../context.tsx';
import { arrangeFor, type ArrangeNote } from '../../arrange/store.ts';
import { plural, whereOrder, type Entry, type Plan } from '../../arrange/model.ts';
import { Avatar } from '../../live/marks.tsx';
import { Icon } from '../../shell/Icons.tsx';
import { LevelTab, Trail } from '../parts.tsx';

/** Text and bold parts in turn (model.ts → Change), as spans and <b>s. */
function Words({ parts }: { parts: string[] }) {
	return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p))}</>;
}

/** Page folders: the folder-only lines (model.ts → Plan.folderLines), as the changes list draws them. */
function FolderLines({ lines, className }: { lines: Plan['folderLines']; className?: string }) {
	return (
		<ul className={`chg${className ? ` ${className}` : ''}`} data-review="folders">
			{lines.map((it, i) => (
				<li key={i} className={it.muted ? 'is-muted' : undefined}>
					<Icon name={it.icon} />
					<span>
						<Words parts={it.parts} />
					</span>
				</li>
			))}
		</ul>
	);
}

export function ArrangeLevel() {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	const brand = useStore(editor.brand, (b) => b.name);
	const count = useStore(editor.documents, (d) => d.length);
	const plan = arrange.plan();
	const reviewing = s.mode !== 'arrange';
	const busy = s.mode === 'applying';
	const sub = plan.orderOnly ? (plan.folderLines.length ? 'Folders and order only' : 'The order only') : `${plan.lead} ${plan.verb} address`;
	return (
		<>
			<Trail>
				<LevelTab name={brand} count={String(count)} onClick={() => arrange.leave()} />
				{reviewing ? <LevelTab name="Arrange pages" onClick={() => arrange.back()} /> : null}
				<div className="cur">
					<div className="cur-row">
						{reviewing ? (
							<button type="button" className="ib" aria-label="Back to arranging" disabled={busy} onClick={() => arrange.back()}>
								<Icon name="chev-l" />
							</button>
						) : (
							<button type="button" className="ib" aria-label="Back to documents" onClick={() => arrange.leave()}>
								<Icon name="chev-l" />
							</button>
						)}
						<div className="cur-title">
							<span className="t">
								<span>{reviewing ? 'Review' : 'Arrange pages'}</span>
							</span>
							<span className="sub">{reviewing ? sub : 'Nothing changes until you apply'}</span>
						</div>
					</div>
				</div>
			</Trail>
			{reviewing ? <Review plan={plan} /> : <Arranging plan={plan} />}
		</>
	);
}

function Arranging({ plan }: { plan: Plan }) {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	useStore(arrange.state);
	const why = arrange.blocked();
	const items = plan.changes;
	return (
		<>
			<div className="side-body" data-arrange="changes">
				<h3 className="sec-h">
					Changes{items.length ? <> <span className="n">{items.length}</span></> : null}
				</h3>
				{items.length ? (
					<ul className="chg">
						{items.map((it, i) => (
							<li key={i} className={it.muted ? 'is-muted' : undefined}>
								<Icon name={it.icon} />
								<span>
									<Words parts={it.parts} />
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="arr-none">None yet. Drag a row on the right to start.</p>
				)}
				<p className="fixed-line">
					<Icon name="clock" />
					<span>Kept only in this tab until you apply. Leaving or reloading the page drops it.</span>
				</p>
			</div>
			<div className="arr-foot">
				{why ? (
					<p className="why" id="rv-why">
						<Icon name="warn" />
						<span>
							<Words parts={why} />
						</span>
					</p>
				) : null}
				<div className="acts">
					<button type="button" className="btn" data-act="cancel" onClick={() => arrange.leave()}>
						Cancel
					</button>
					<button type="button" className="btn ink" data-act="review" disabled={!!why} aria-describedby={why ? 'rv-why' : undefined} onClick={() => arrange.review()}>
						Review…
					</button>
				</div>
			</div>
		</>
	);
}

function Note({ note }: { note: ArrangeNote }) {
	if (note.kind === 'lock') {
		return (
			<div className="note lock" role="alert" data-note="arrange-lock">
				{note.person ? <Avatar person={note.person} size="sm" /> : <Icon name="lock" />}
				<div>
					<b>{note.error}</b>
					<p>So nothing was applied. It frees up when they close it, or a few minutes after they stop typing. Then apply again.</p>
				</div>
			</div>
		);
	}
	if (note.kind === 'underneath') {
		return (
			<div className="note warn" role="alert" data-note="arrange-underneath">
				<Icon name="warn" />
				<div>
					<b>Something changed since you opened this</b>
					{[...note.lines, ...note.clashes].map((line, i) => (
						<p key={i}>{line}</p>
					))}
					<p>{note.clashes.length ? 'Nothing was applied. Go back and arrange it again.' : 'Nothing was applied. The list below is worked out again on the site as it is now: check it, then apply.'}</p>
				</div>
			</div>
		);
	}
	if (note.kind === 'refused') {
		return (
			<div className="note warn" role="alert" data-note="arrange-refused">
				<Icon name="warn" />
				<div>
					<b>Nothing was applied</b>
					<p>{note.error}</p>
				</div>
			</div>
		);
	}
	return (
		<div className="note danger" role="alert" data-note="arrange-failed">
			<Icon name="warn" />
			<div>
				<b>Couldn’t apply this</b>
				<p>{note.error} Nothing on the site changed, and your arrangement is still here. Try again.</p>
			</div>
		</div>
	);
}

function Review({ plan }: { plan: Plan }) {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	const busy = s.mode === 'applying';
	const where = whereOrder(plan);
	const putin = plan.entries.find((e) => e.t === 'putin');
	const takeout = plan.entries.find((e) => e.t === 'takeout');
	const absorbed = plan.entries.find((e) => e.t === 'absorbed');
	const lead = putin
		? `${putin.label} goes into the addresses at ${putin.toA}, in the folder’s place. Each page takes what’s under it.`
		: takeout
			? `${takeout.label} comes out of the addresses: a folder named ${takeout.label} takes its place, its pages in the same order.`
			: absorbed
				? `The ${absorbed.folder} folder goes into the addresses at ${absorbed.at}. Each page takes what’s under it.`
				: 'Each page takes what’s under it.';
	const clashed = s.note?.kind === 'underneath' && s.note.clashes.length > 0;
	const publish = editor.mode === 'live' ? ' Goes live at the next Publish.' : '';
	return (
		<>
			<div className="side-body" data-arrange="review">
				{s.note ? <Note note={s.note} /> : null}
				{plan.orderOnly && plan.folderLines.length ? (
					<>
						<div className="panel" data-review="order-only">
							<h3>No address changes; the Pages tree’s folders and order change</h3>
							<p>Every page keeps its address, so nothing needs a redirect. Only the editor’s Pages tree reads folders: the site’s menus stay as they are.</p>
						</div>
						<h3 className="sec-h" style={{ marginTop: 'var(--space-5)' }}>
							What changes
						</h3>
						<FolderLines lines={plan.folderLines} />
					</>
				) : plan.orderOnly ? (
					<div className="panel" data-review="order-only">
						<h3>No address changes; the order of the Pages tree changes</h3>
						<p>
							{where ? `${where[0]!.toUpperCase()}${where.slice(1)}. ` : ''}Only the editor’s Pages tree reads this order: the site’s menus stay as they are in Site Settings.
						</p>
					</div>
				) : (
					<>
						<p className="rv-lead">
							{plan.lead} {plan.verb} address
							<small>
								{lead}
								{plan.reorders.length ? ` The order changes ${where} too.` : ''}
							</small>
						</p>
						<h3 className="sec-h">Old → new address</h3>
						<ul className="rv">
							{plan.entries.map((e, i) => (
								<ReviewEntry key={`${e.t}:${e.id}:${i}`} entry={e} />
							))}
						</ul>
						{plan.folderLines.length ? <FolderLines lines={plan.folderLines} className="rv-after" /> : null}
						<p className="fixed-line">
							<Icon name="shared" />
							<span>Links to these pages from the site’s own pages change to the new addresses.</span>
						</p>
						{plan.live ? (
							<div className="rv-tick">
								<label className="check">
									<input type="checkbox" id="rv-tick" checked={s.tick} disabled={busy} aria-describedby="rv-tick-h" onChange={(e) => arrange.setTick(e.target.checked)} />
									<span>Leave redirects from the old addresses</span>
								</label>
								<p className="field-help" id="rv-tick-h">
									{s.tick ? `Anyone with an old address lands on its page’s new one.${publish}` : 'Nothing will be at the old addresses: links to them from elsewhere will find no page.'}
								</p>
							</div>
						) : null}
					</>
				)}
			</div>
			<div className="arr-foot">
				{busy ? (
					<>
						<div className="progress" aria-hidden="true" />
						<p className="busy" role="status">
							Applying: {plan.orderOnly ? (plan.folderLines.length ? 'saving the folders and order' : 'saving the order') : `moving ${plan.lead}`}…
						</p>
					</>
				) : null}
				<div className="acts">
					<button type="button" className="btn" data-act="back" disabled={busy} onClick={() => arrange.back()}>
						Back
					</button>
					<button type="button" className="btn ink" data-act="apply" disabled={busy || clashed} onClick={() => void arrange.apply()}>
						{busy ? 'Applying…' : 'Apply'}
					</button>
				</div>
			</div>
		</>
	);
}

function Move({ from, to }: { from: string; to: string }) {
	return (
		<div className="mv">
			<span className="fr">{from}</span>
			<span aria-hidden="true">→</span>
			<span className="sr">becomes</span>
			<span className="to">{to}</span>
		</div>
	);
}

function ReviewEntry({ entry: e }: { entry: Entry }) {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	const style = { ['--in' as string]: e.ind };
	const linked = (id: string) => ({ onMouseEnter: () => arrange.setLinked(id), onMouseLeave: () => arrange.setLinked(null) });
	if (e.t === 'newgroup') {
		return (
			<li className="rv-e is-grp" style={style} data-link={e.id} {...linked(e.id)}>
				<Icon name="folder" />
				<div className="t">
					<span>{e.label}</span>
					<span className="chip select">New group</span>
				</div>
			</li>
		);
	}
	if (e.t === 'rename' || e.t === 'groupmove') {
		return (
			<li className="rv-e is-grp" style={style} data-link={e.id} {...linked(e.id)}>
				<Icon name="folder" />
				<div className="t">
					<span>{e.t === 'rename' ? `${e.from} is renamed ${e.to}` : `${e.label} moves ${e.dest ? `into ${e.dest}` : 'to the top level'}`}</span>
				</div>
				<Move from={e.fromA} to={e.toA} />
			</li>
		);
	}
	// Page folders: a folder into the addresses and back, a folder moved to another level, a row taking a folder's place.
	if (e.t === 'putin' || e.t === 'takeout') {
		return (
			<li className="rv-e is-grp" style={style} data-link={e.id} data-review={e.t} {...linked(e.id)}>
				<Icon name={e.t === 'putin' ? 'folder-addr' : 'folder'} />
				<div className="t">
					<span>{e.t === 'putin' ? `${e.label} becomes a group` : `${e.label} becomes a folder`}</span>
					<span className="chip select">{e.t === 'putin' ? 'Was a folder' : 'Was a group'}</span>
				</div>
				{e.t === 'putin' ? (
					<div className="mv">
						<span className="fr plain">Not in the addresses</span>
						<span aria-hidden="true">→</span>
						<span className="sr">becomes</span>
						<span className="to">{e.toA}</span>
					</div>
				) : (
					<div className="mv">
						<span className="fr">{e.fromA}</span>
						<span aria-hidden="true">→</span>
						<span className="sr">becomes</span>
						<span className="to plain">Not in the addresses</span>
					</div>
				)}
			</li>
		);
	}
	if (e.t === 'fmove') {
		return (
			<li className="rv-e is-grp" style={style} data-link={e.id} data-review="fmove" {...linked(e.id)}>
				<Icon name="folder" />
				<div className="t">
					<span>{`${e.label} moves ${e.dest ? `into ${e.dest}` : 'to the top level'}, with its rows`}</span>
				</div>
			</li>
		);
	}
	if (e.t === 'absorbed') {
		return (
			<li className="rv-e" style={style} data-link={e.id} data-review="absorbed" {...linked(e.id)}>
				<Icon name="page" />
				<div className="t">
					<span>{e.label} becomes the page these go under</span>
				</div>
				<div className="mv">
					<span className="fr">{e.at}</span>
					<span aria-hidden="true">→</span>
					<span className="sr">becomes</span>
					<span className="to plain">stays</span>
				</div>
			</li>
		);
	}
	if (e.t === 'gone') {
		return (
			<li className="rv-e is-gone" style={style} data-link={e.id} data-review="gone" {...linked(e.id)}>
				<Icon name="folder" />
				<div className="t">
					<span>{e.label} goes: no pages left in it</span>
				</div>
			</li>
		);
	}
	if (e.t === 'joined') {
		return (
			<li className="rv-e is-grp" style={style} data-link={e.id} data-review="joined" {...linked(e.id)}>
				<Icon name="folder" />
				<div className="t">
					<span>{e.how === 'drop' ? `${e.into} becomes ${e.label}’s own page` : `${e.label} joins ${e.into}: its pages go under it`}</span>
				</div>
			</li>
		);
	}
	if (e.t === 'held') {
		const open = s.openHeld.includes(e.id);
		const added = e.held.docs.filter((d) => s.addedDocs.includes(d.path)).length;
		return (
			<li className="rv-e is-held" style={style} data-link={`held:${e.id}`} data-review="held" {...linked(`held:${e.id}`)}>
				<Icon name={e.held.icon} />
				<div className="t">
					<span>and its {plural(e.held.docs.length, e.held.one, e.held.many)}</span>
					{added ? <span className="chip warn">{added} added since</span> : null}
					<button type="button" className="linkbtn subtle rv-more" aria-expanded={open} onClick={() => arrange.toggleHeld(e.id)}>
						{open ? 'Hide' : 'Show each'} <Icon name="chev-r" size="xs" />
					</button>
				</div>
				<Move from={e.from} to={e.to} />
				{open ? (
					<ol className="rv-docs" aria-label={`Each of ${e.holder}’s ${e.held.many}, at its new address`}>
						{/* Added since you opened this, first (Decision 10). */}
						{[...e.held.docs.filter((d) => s.addedDocs.includes(d.path)), ...e.held.docs.filter((d) => !s.addedDocs.includes(d.path))].map((d) => (
							<li key={d.path} className={s.addedDocs.includes(d.path) ? 'is-new' : undefined} title={s.addedDocs.includes(d.path) ? 'Added since you opened this' : undefined}>
								{e.base}/{d.path}
							</li>
						))}
					</ol>
				) : null}
			</li>
		);
	}
	if (e.t !== 'move' && e.t !== 'carried') return null;
	return (
		<li className={`rv-e${e.t === 'carried' ? ' is-carried' : ''}`} style={style} data-link={e.id} data-review={e.t} {...linked(e.id)}>
			<Icon name="page" />
			<div className="t">
				<span>{e.label}</span>
				{e.vis === 'hidden' ? (
					<span className="chip warn" title="The page it goes under is hidden, so the public site stops showing it">
						Will be hidden
					</span>
				) : e.vis === 'shown' ? (
					<span className="chip live" title="It leaves the hidden page it was under, so the public site shows it">
						Will be shown
					</span>
				) : null}
				{s.added.includes(e.id) ? <span className="chip warn">Added since you opened this</span> : null}
			</div>
			<Move from={e.from} to={e.to} />
		</li>
	);
}
