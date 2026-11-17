/**
 * The field frame (M2 → components: label, help, chips, meta; the mockup's
 * fieldHTML): one per field in the block level. It shows the field as picked (a
 * wash and a full thin border, never a side rail), "Picked from the page" when a
 * click on the page picked it, and "Typing on the page" while it's typed there.
 *
 * Focusing anything inside picks the field (`view.field`), as in the mockup; a
 * field already picked from the page keeps its chip. Inside a field host
 * (host.tsx: M5a's fields, and a fields document's form in Phase 5), picking goes
 * through the host, and a path inside the field (`credits.1.name`, from an element
 * with `data-path`) picks that path, so the preview rings exactly that item. A
 * field is shown picked for its own key or any path inside it.
 *
 * M6c (G8): `help` (the field's own, from the config) sits under the label, in the
 * quiet secondary text the editor's own help lines use (`.field-help`).
 *
 * Edit in context, Decision 15: a picked field is brought into view in the form (its group
 * opens first, GroupField.tsx → useReveal), scrolled to the middle when it's out of sight. Only
 * the innermost frame picked moves the form.
 */
import { useEffect, useRef, type FocusEvent, type ReactNode } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { pageEditFor, type Typing } from '../preview/page-edit.ts';
import { Icon } from '../shell/Icons.tsx';
import { createStore, type Store } from '../state/store.ts';
import { useFieldHost, within } from './host.tsx';
import { staleFields, staleKey } from './stale.ts';

const noTyping: Store<Typing | null> = createStore<Typing | null>(null);

/** The field being typed on the page (null on the server). */
export function useTyping(): Typing | null {
	const editor = useEditor();
	return useStore(pageEditFor(editor)?.typing ?? noTyping);
}

export function FieldFrame(props: {
	blockKey: string;
	name: string;
	/** The label; `htmlFor` makes it a <label>, otherwise a span (for a group of inputs). */
	label: string;
	htmlFor?: string;
	labelId?: string;
	/** Extra classes on `.field` (`lk-field`, `phone`). */
	className?: string;
	/** Teal when picked (a lockup's phone lines). */
	phone?: boolean;
	chips?: ReactNode;
	meta?: ReactNode;
	/** M6c (G8): the field's help, plain text under the label. */
	help?: string;
	children: ReactNode;
}) {
	const editor = useEditor();
	const host = useFieldHost();
	const picked = useStore(editor.view, (v) =>
		host ? within(host.picked(v), props.name) : v.level === 'block' && v.block === props.blockKey && v.field === props.name,
	);
	const fromPage = useStore(editor.view, (v) => v.picked);
	const pickedPath = useStore(editor.view, (v) => v.field);
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!picked) return;
		let raf = 0;
		// Two frames: a group opened by the pick has laid out by then.
		raf = requestAnimationFrame(() => {
			raf = requestAnimationFrame(() => {
				const el = frame.current;
				const body = el?.closest('.side-body');
				if (!el || !body || el.querySelector('.field-frame.is-picked')) return;
				const r = el.getBoundingClientRect();
				const b = body.getBoundingClientRect();
				if (r.top >= b.top && r.bottom <= b.bottom) return;
				const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
				el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
			});
		});
		return () => cancelAnimationFrame(raf);
	}, [picked, pickedPath]);
	const typing = useTyping();
	const typingHere = !!typing && typing.key === props.blockKey && typing.field === props.name;
	// Changed while the preview can't render: the field says so (the mockup's #preview-failed).
	const failed = useStore(editor.previewStatus, (s) => s.failed);
	const stale = useStore(staleFields(editor), (s) => s.has(staleKey(props.blockKey, props.name)));
	const onFocus = (event: FocusEvent) => {
		if (host) {
			// The innermost path focused: `credits.1.name` inside the credits field.
			const path = (event.target as Element).closest?.('[data-path]')?.getAttribute('data-path');
			host.pick(path && within(path, props.name) ? path : props.name);
			return;
		}
		const view = editor.view.get();
		if (view.field !== props.name) editor.view.update({ field: props.name, picked: false });
	};
	const chip = typingHere ? (
		<span className="chip select typing">Typing on the page</span>
	) : picked && fromPage ? (
		<span className="chip select picked-chip">
			<Icon name="target" size="xs" />
			Picked from the page
		</span>
	) : null;
	return (
		<div ref={frame} className={`field-frame${picked ? ' is-picked' : ''}${picked && props.phone ? ' phone' : ''}`} data-ff={props.name} onFocus={onFocus}>
			<div className={`field${props.className ? ` ${props.className}` : ''}`} data-field={props.name}>
				<div className="field-head">
					{props.htmlFor ? (
						<label htmlFor={props.htmlFor}>{props.label}</label>
					) : (
						<span className="field-label" id={props.labelId}>
							{props.label}
						</span>
					)}
					{chip}
					{failed && stale ? (
						<span className="chip warn" data-stale="">
							<Icon name="warn" size="xs" />
							Not in the preview yet
						</span>
					) : null}
					{props.chips}
					{props.meta}
				</div>
				{props.help ? (
					<p className="field-help" data-help="">
						{props.help}
					</p>
				) : null}
				{props.children}
			</div>
		</div>
	);
}
