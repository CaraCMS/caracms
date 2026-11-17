/**
 * The lockup field (Decision 12; M2 → the lockup field; the mockup's lockupField):
 * one input row per line, edited in the sidebar only.
 *
 * - **Keys** (lockup-rules.ts → lineKey): Enter starts a new line at the caret, ⌫ at
 *   a line's start joins it to the line above, ↑/↓ move between lines.
 * - **Main lines / Phone lines** (on Phone): Phone lines are the same words broken
 *   differently, so only Enter (between words) and ⌫ (at a line's start) work there;
 *   anything else nudges the hint. "Give Phone its own lines" splits the longest line
 *   at the most even space (splitEvenly). Editing the main lines keeps the phone
 *   breaks if the word count holds, otherwise drops them with an inline notice
 *   (withMainLines). "Use main lines" drops them with Undo, and the file holds the
 *   plain list again (Decision 10).
 * - On Desktop and Tablet, a lockup with phone lines says so ("Phone has its own lines").
 * - **Warnings** (none blocks anything, M2 Decision 12): "Too long for mobile:
 *   shorten a line or split it" (M2 Decision 17), from the size the phone iframe
 *   computed (previewStatus.warnings; M1 → E7), with the fix offered; characters the
 *   font doesn't cover (Decision 15), from the render's markers.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { titleCase, type LockupField as LockupDescriptor } from '../../../fields.ts';
import { own } from '../../../document.ts';
import { sameDoc } from '../../types.ts';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { joinUp, lineKey, lockupValue, splitLine, withMainLines, withoutPhone, withPhone, type LineCaret, type LineSet } from './lockup-rules.ts';
import { fieldElement } from '../preview/markers.ts';

export const PHONE_LINES_DROPPED = 'Phone uses the main lines again';

/** Characters the font doesn't cover, per line set, as the latest render marked them (Decision 15). */
function useUncovered(index: number, name: string): { main: string[]; phone: string[] } {
	const editor = useEditor();
	const [found, setFound] = useState<{ main: string[]; phone: string[] }>({ main: [], phone: [] });
	useEffect(() => {
		const driver = editor.preview;
		if (!driver) return;
		const read = () => {
			const doc = driver.frames().find((f) => f.width === 'desktop')?.document;
			const heading = doc ? fieldElement(doc, index, name, 'lockup') : null;
			const of = (set: string) => {
				const raw = heading?.querySelector<HTMLElement>(`[data-cms-lines="${set}"]`)?.dataset.cmsUncovered;
				try {
					return raw ? (JSON.parse(raw) as string[]) : [];
				} catch {
					return [];
				}
			};
			const next = { main: of('main'), phone: of('phone') };
			setFound((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
		};
		read();
		const stops = [driver.onMorph(read), driver.onLoad(read)];
		return () => stops.forEach((s) => s());
	}, [editor, index, name]);
	return found;
}

/** Lines as text with a <br> between them (the mockup's lk-ref and lk-phone-sum). */
const withBreaks = (lines: readonly string[]) => lines.flatMap((line, i) => (i ? [<br key={i} />, line] : [line]));

const quote = (chars: string[]) => chars.map((c) => `“${c}”`).join(', ');

export function LockupField(props: { blockKey: string; index: number; name: string; label: string; field: LockupDescriptor; value: unknown }) {
	const editor = useEditor();
	const { blockKey, name } = props;
	const value = lockupValue(props.value);
	const hasPhone = !!value.phone;
	const width = useStore(editor.view, (v) => v.width);
	const onPhone = width === 'phone';
	const [chosen, setChosen] = useState<LineSet | null>(null);
	const mode: LineSet = onPhone ? (chosen ?? (hasPhone ? 'phone' : 'main')) : 'main';
	const ph = mode === 'phone' && hasPhone;
	const [dropped, setDropped] = useState(false);
	const pending = useRef<{ set: LineSet; focus: LineCaret } | null>(null);
	const rows = useRef<HTMLDivElement>(null);
	const under = useRef<HTMLDivElement>(null);
	const style = own(editor.site.textStyles, props.field.style);
	const styleName = style ? titleCase(style.name) : titleCase(props.field.style);
	const labelId = `lk-${blockKey}-${name}`;

	// The warning, from the phone iframe's computed size, for the document the preview shows.
	const showing = useStore(editor.previewStatus, (s) => s.showing);
	const warnings = useStore(editor.previewStatus, (s) => s.warnings);
	const live = sameDoc(showing, editor.doc.get().ref);
	const warning = live ? warnings.find((w) => w.block === props.index && w.field === name) : undefined;
	const uncovered = useUncovered(props.index, name);

	// Where the caret goes after a split, a join or a new line.
	useLayoutEffect(() => {
		const want = pending.current;
		if (!want) return;
		const input = rows.current?.querySelector<HTMLInputElement>(`input[data-set="${want.set}"][data-line="${want.focus.line}"]`);
		if (!input) return;
		pending.current = null;
		input.focus();
		input.setSelectionRange(want.focus.caret, want.focus.caret);
	});

	// Phone lines: nothing that would change the words gets in (paste, drop, autocorrect).
	useEffect(() => {
		const el = rows.current;
		if (!el) return;
		const guard = (event: Event) => {
			if ((event.target as Element | null)?.matches?.('input[data-set="phone"]')) {
				event.preventDefault();
				nudge();
			}
		};
		el.addEventListener('beforeinput', guard);
		return () => el.removeEventListener('beforeinput', guard);
	});

	function nudge() {
		const u = under.current;
		if (u) {
			u.classList.remove('nudge');
			void u.offsetWidth;
			u.classList.add('nudge');
		}
		editor.announce('Phone lines keep the same words. Change the words in the main lines.');
	}

	function setMain(lines: string[]) {
		const next = withMainLines(value, lines);
		editor.doc.setField(blockKey, name, next.value);
		if (next.dropped) {
			setDropped(true);
			setChosen('main');
			editor.announce('Words changed; Phone uses the main lines again.');
		}
	}

	function setLines(set: LineSet, lines: string[]) {
		if (set === 'main') setMain(lines);
		else editor.doc.setField(blockKey, name, { lines: value.lines, phone: lines });
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>, set: LineSet, line: number) {
		const input = event.currentTarget;
		const lines = set === 'phone' ? value.phone ?? [] : value.lines;
		const start = input.selectionStart ?? 0;
		const end = input.selectionEnd ?? start;
		const action = lineKey(set, event.key, { line, start, end }, { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
		if (action === 'pass') return;
		if (action === 'up' || action === 'down') {
			const next = rows.current?.querySelector<HTMLInputElement>(`input[data-set="${set}"][data-line="${line + (action === 'down' ? 1 : -1)}"]`);
			if (next) {
				event.preventDefault();
				next.focus();
			}
			return;
		}
		event.preventDefault();
		if (action === 'refuse') {
			if (set === 'phone') nudge();
			return;
		}
		const edit = action === 'split' ? splitLine(lines, set, { line, caret: start }) : joinUp(lines, line);
		if (!edit) {
			nudge();
			return;
		}
		pending.current = { set, focus: edit.focus };
		setLines(set, edit.lines);
	}

	function givePhone() {
		editor.doc.setField(blockKey, name, withPhone(value));
		setChosen('phone');
		setDropped(false);
		editor.view.update({ field: name, picked: false });
		if (!onPhone) editor.setWidth('phone');
		pending.current = { set: 'phone', focus: { line: Math.min(1, Math.max(0, withPhone(value).phone!.length - 1)), caret: 0 } };
		editor.announce('Phone has its own lines.');
	}

	function dropPhone() {
		editor.doc.setField(blockKey, name, withoutPhone(value), { undoLabel: PHONE_LINES_DROPPED });
		setChosen('main');
	}

	function addLine() {
		pending.current = { set: 'main', focus: { line: value.lines.length, caret: 0 } };
		setMain([...value.lines, '']);
	}

	const lines = ph ? value.phone! : value.lines;
	const warnLines = warning?.set === 'phone' && value.phone ? value.phone : value.lines;
	const longest = warnLines.reduce((a, b) => (b.length > a.length ? b : a), '');
	const missing = [...new Set([...uncovered.main, ...uncovered.phone])];

	return (
		<FieldFrame
			blockKey={blockKey}
			name={name}
			label={props.label}
			help={props.field.help}
			labelId={labelId}
			className={`lk-field${ph ? ' phone' : ''}`}
			phone={ph}
			chips={
				hasPhone && !onPhone ? (
					<span className="chip phone">
						<Icon name="phone" size="xs" />
						Phone lines
					</span>
				) : null
			}
			// Editor wording note (caracms-cloud adversarial review): "Lockup" is the package's word, not an editor's.
			meta={<span className="field-meta">Heading style: {styleName}</span>}
		>
			{onPhone ? (
				<div className="mini-seg" role="radiogroup" aria-label="Which lines to edit">
					<button type="button" role="radio" aria-checked={mode === 'main'} onClick={() => setChosen('main')}>
						Main lines
					</button>
					<button type="button" role="radio" className="ph" aria-checked={mode === 'phone'} onClick={() => setChosen('phone')}>
						<Icon name="phone" size="xs" />
						Phone lines{hasPhone ? null : <span className="none"> · none</span>}
					</button>
				</div>
			) : null}

			{mode === 'phone' && !hasPhone ? (
				<div className="note phone tight">
					<Icon name="phone" />
					<div>
						<b>Phone uses the main lines</b>
						<div className="acts">
							<button type="button" className="btn sm phone" onClick={givePhone}>
								Give Phone its own lines
							</button>
						</div>
					</div>
				</div>
			) : (
				<>
					<div className="lk-rows" role="group" aria-labelledby={labelId} ref={rows}>
						{lines.map((line, i) => (
							<div className="lk-row" key={i}>
								<span className="n" aria-hidden="true">
									{i + 1}
								</span>
								<input
									value={line}
									data-set={ph ? 'phone' : 'main'}
									data-line={i}
									aria-label={`Line ${i + 1}${ph ? ' on Phone' : ''}`}
									spellCheck={false}
									autoComplete="off"
									onKeyDown={(e) => onKeyDown(e, ph ? 'phone' : 'main', i)}
									onChange={(e) => {
										if (ph) return;
										const next = [...value.lines];
										next[i] = e.target.value;
										setMain(next);
									}}
								/>
							</div>
						))}
					</div>
					{ph ? (
						<div className="lk-under phone" ref={under}>
							<Icon name="check" size="xs" />
							<span>Same words, broken for phones.</span>
						</div>
					) : (
						<div className="lk-under" ref={under}>
							<button type="button" className="linkbtn subtle" onClick={addLine}>
								<Icon name="plus" size="xs" />
								Add line
							</button>
						</div>
					)}
				</>
			)}

			{dropped && !hasPhone ? (
				<div className="note phone tight lk-dropped" style={{ marginTop: 'var(--space-2)' }}>
					<Icon name="phone" />
					<div>
						<p>Words changed; Phone uses the main lines again.</p>
					</div>
				</div>
			) : null}

			<div className="lk-status">
				{warning?.tooLong ? (
					<div className="note warn tight" role="status" data-warning="too-long">
						<Icon name="warn" />
						<div>
							<b>Too long for mobile: shorten a line or split it</b>
							{/* Editor wording note: what happens, not the sizes. A line never wraps; the heading shrinks to fit its longest line. */}
							<p>On a phone, the heading shrinks so “{longest}” fits on one line, and comes out smaller than this heading style is meant to go.</p>
							{hasPhone ? null : (
								<div className="acts">
									{!onPhone ? (
										<button type="button" className="btn sm" onClick={() => editor.setWidth('phone')}>
											<Icon name="phone" size="sm" />
											Show on Phone
										</button>
									) : null}
									<button type="button" className="btn sm phone" onClick={givePhone}>
										Give Phone its own lines
									</button>
								</div>
							)}
						</div>
					</div>
				) : warning ? (
					<p className="lk-ok" data-warning="fits">
						<Icon name="check" size="xs" />
						Fits on Phone{hasPhone ? ' with its own lines' : ''} · {Math.round(warning.px)}px
					</p>
				) : null}
				{missing.length > 0 ? (
					<div className="note warn tight lk-uncovered" role="status" data-warning="uncovered" style={{ marginTop: 'var(--space-2)' }}>
						<Icon name="warn" />
						<div>
							<p>
								{quote(missing)} {missing.length === 1 ? "isn't" : "aren't"} in this font, so this line may not fit.
							</p>
						</div>
					</div>
				) : null}
			</div>

			{!onPhone && hasPhone ? (
				<div className="lk-phone-sum">
					<Icon name="phone" size="xs" />
					<span className="h">Phone has its own lines</span>
					<button
						type="button"
						className="linkbtn"
						onClick={() => {
							setChosen('phone');
							editor.view.update({ field: name, picked: false });
							editor.setWidth('phone');
						}}
					>
						Edit on Phone
					</button>
					<span className="l">{withBreaks(value.phone!)}</span>
				</div>
			) : null}

			{ph ? (
				<>
					<div className="lk-ref">
						<div className="h">Main lines · Tablet and Desktop</div>
						<div className="l">{withBreaks(value.lines)}</div>
					</div>
					<div className="lk-acts">
						<button type="button" className="btn sm" onClick={dropPhone}>
							Use main lines
						</button>
						<span>Drops Phone's own lines</span>
					</div>
				</>
			) : null}
		</FieldFrame>
	);
}
