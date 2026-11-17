/**
 * The one bar, dark, along the bottom (the mockup's renderBar): the brand slots and
 * the document switcher's trigger on the left (the site's name is the sidebar's,
 * at its top; so is the sidebar's button, SideToggle.tsx); the width toggle with its scale
 * under the preview; the keep state on the right. In live mode (M4) the waiting
 * count with Publish (live/publish.tsx) and the signed-in avatar (live/session.tsx)
 * follow it, and a locked document's trigger has a lock; in local mode their places
 * stay empty, as in M3.
 */
import { SWITCHER_READY } from '../pane/switcher.tsx';
import { useEditor, useStore } from '../context.tsx';
import { TRUE_WIDTH, WIDTHS, WIDTH_LABEL, docId } from '../../types.ts';
import { PublishButton } from '../live/publish.tsx';
import { AccountButton } from '../live/session.tsx';
import { BrandMark, useBrand } from './Brand.tsx';
import { Icon } from './Icons.tsx';
import { useFrameScale } from './Stage.tsx';

export function Bar() {
	const editor = useEditor();
	const brand = useBrand();
	const docTitle = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	// M6: the inbox names itself (it has no document of its own).
	const inInbox = useStore(editor.view, (v) => v.level === 'submissions');
	const title = inInbox ? 'Submissions' : docTitle;
	const width = useStore(editor.view, (v) => v.width);
	const pop = useStore(editor.view, (v) => v.pop);
	const viewOpening = useStore(editor.view, (v) => v.opening);
	const renderOpening = useStore(editor.previewStatus, (s) => s.opening);
	const failed = useStore(editor.previewStatus, (s) => s.failed);
	const warnings = useStore(editor.previewStatus, (s) => s.warnings);
	const documents = useStore(editor.documents);
	const scale = useFrameScale(width);
	const veil = useStore(editor.access, (a) => a.veil);
	// Review gaps (Decision 7): a block state chosen, its render on the way.
	const showingState = useStore(editor.blockState, (st) => (st?.waiting ? st.name : null));
	const tooLong = warnings.filter((w) => w.tooLong).length;
	const opening = viewOpening ?? renderOpening;
	const openingLabel = opening ? (documents.find((d) => docId(d) === docId(opening))?.label ?? opening.path) : null;

	const openSwitcher = () => {
		if (SWITCHER_READY) editor.setPop(pop === 'switcher' ? null : 'switcher');
		else editor.goTo('documents');
	};

	let note = null;
	const stateLabel = showingState ? stateLabelOf(editor, showingState) : null;
	if (openingLabel) note = <span className="bar-note">Opening {openingLabel}…</span>;
	else if (stateLabel)
		note = (
			<span className="bar-note" role="status" data-bar-note="state">
				<span className="pulse" aria-hidden="true" />
				Showing {stateLabel}…
			</span>
		);
	else if (failed)
		note = (
			<button
				type="button"
				className="bar-warn"
				aria-haspopup="dialog"
				aria-expanded={pop === 'preview-trouble'}
				onClick={() => editor.setPop(pop === 'preview-trouble' ? null : 'preview-trouble')}
			>
				<Icon name="warn" size="sm" />
				Preview not updated
			</button>
		);

	return (
		<footer className="bar" id="bar" aria-label="Editor bar">
			<div className="bar-l">
				<span className="logo-slot" title={brand.name}>
					<BrandMark />
				</span>
				<button
					type="button"
					className="docbtn"
					aria-haspopup="dialog"
					aria-expanded={pop === 'switcher'}
					aria-label={`${title}: go to another document`}
					onClick={openSwitcher}
				>
					{veil ? <Icon name="lock" size="sm" /> : null}
					<span className="t">{title}</span>
					<Icon name="chev-u" size="xs" />
					<kbd>⌘K</kbd>
				</button>
			</div>
			<div className="bar-r">
				<div className="bar-a">{note}</div>
				<div className="bar-c">
					<div className="seg" role="radiogroup" aria-label="Preview width">
						{WIDTHS.map((w) => (
							<button key={w} type="button" role="radio" aria-checked={width === w} data-width={w} onClick={() => editor.setWidth(w)}>
								{WIDTH_LABEL[w]}
								<span className="w">{TRUE_WIDTH[w]}</span>
								{w === 'phone' && tooLong > 0 ? (
									<>
										<span className="wdot" aria-hidden="true" />
										<span className="tip" role="tooltip">
											<b>
												{tooLong} thing{tooLong > 1 ? 's' : ''}
											</b>{' '}
											too long for mobile
										</span>
										<span className="sr">
											, {tooLong} thing{tooLong > 1 ? 's' : ''} too long for mobile
										</span>
									</>
								) : null}
							</button>
						))}
					</div>
					<span className="scale" title={scale ? `Shown at ${Math.round(scale * 100)}% of its real size` : undefined}>
						{scale === null ? '' : scale >= 0.995 ? '1×' : `${scale.toFixed(2)}×`}
					</span>
				</div>
				<div className="bar-e">
					<Keep />
					{editor.mode === 'live' ? (
						<>
							<PublishButton />
							<AccountButton />
						</>
					) : (
						<>
							{/* Local mode (M3): the waiting count, Publish and the avatar are live mode's. */}
							<span data-slot="publish" hidden />
							<span data-slot="account" hidden />
						</>
					)}
				</div>
			</div>
		</footer>
	);
}

function Keep() {
	const editor = useEditor();
	const state = useStore(editor.keep, (k) => k.state);
	const error = useStore(editor.keep, (k) => k.error);
	const unsent = useStore(editor.keep, (k) => k.unsent ?? 0);
	const signedOut = useStore(editor.liveState, (s) => !!s.signedOut);
	// caracms-cloud adversarial review, finding 4: the server has the edits, but its commits to GitHub keep failing.
	const trouble = useStore(editor.liveState, (s) => s.status?.commitTrouble ?? null);
	if (state === 'signedout' || (signedOut && state !== 'offline')) {
		return (
			<span className="keep loud" role="status" data-keep="signedout">
				<Icon name="signout" size="sm" />
				{unsent > 0 ? 'Not kept: signed out' : 'Signed out'}
			</span>
		);
	}
	if (state === 'held') {
		// Live mode: a 409, or another editor's change since. The document's note says why, with Use mine.
		return (
			<span className="keep loud" role="status" data-keep="held" title="Your latest changes are held in this browser">
				<Icon name="warn" size="sm" />
				Not kept
			</span>
		);
	}
	if (state === 'keeping') {
		return (
			<span className="keep" role="status" data-keep="keeping">
				<span className="pulse" aria-hidden="true" />
				Keeping…
			</span>
		);
	}
	if (state === 'offline') {
		return (
			<span className="keep loud" role="status" data-keep="offline" title={error ?? undefined}>
				<Icon name="offline" size="sm" />
				Can't reach the server
			</span>
		);
	}
	if (state === 'refused') {
		// The server answered and said no (a 4xx): not "can't reach". Its message is in the pane's note.
		return (
			<span className="keep loud" role="status" data-keep="refused" title={error ?? undefined}>
				<Icon name="warn" size="sm" />
				Not kept
			</span>
		);
	}
	if (trouble && editor.mode === 'live') {
		// Not Kept: kept in Redis, but not reaching GitHub. The pane's note says who can fix it.
		return (
			<span className="keep loud" role="status" data-keep="not-reaching" title={trouble.message}>
				<Icon name="warn" size="sm" />
				Saved here, not reaching GitHub
			</span>
		);
	}
	return (
		<span className="keep" data-keep="kept">
			<Icon name="check" size="sm" />
			Kept
		</span>
	);
}

/** The switch's label for the chosen state (review gaps, Decision 7), from the block it's on. */
function stateLabelOf(editor: ReturnType<typeof useEditor>, name: string): string {
	const s = editor.blockState.get();
	const page = editor.doc.get();
	const type = s && s.key ? page.document.blocks.find((b) => b.key === s.key)?.type : undefined;
	const states = type ? editor.site.blocks[type]?.states : Object.values(editor.site.blocks).find((b) => b.states && Object.hasOwn(b.states, name))?.states;
	return states?.[name] ?? name;
}
