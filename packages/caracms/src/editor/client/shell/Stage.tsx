/**
 * The stage: three iframes of the preview route at 1440, 768 and 375, one shown,
 * the other two laid out behind it (`inert`, opacity 0; never display: none,
 * Decision 13 and M2 Decision 4). Each at its true width, scaled to fit (layout.ts).
 *
 * No flicker (M2 Decision 9): the server renders the iframes, so they start
 * loading before the editor hydrates; until the first preview has painted the stage
 * is a still surface (`unpainted`), then it fades in once (`painting`). The width
 * switch crossfades. Another document's preview swaps in by morph (driver.ts), so
 * the old one stays on screen until the new one is there.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { previewSrc } from '../preview/driver.ts';
import { stageLayout } from '../preview/layout.ts';
import { TRUE_WIDTH, WIDTHS, WIDTH_LABEL, type Width } from '../../types.ts';
import { Icon } from './Icons.tsx';
import { LibraryStage } from '../media/LibraryStage.tsx';
import { InboxStage } from '../inbox/InboxStage.tsx';
import { CollectionTable, useTableCollection } from '../collections/CollectionTable.tsx';
import { ArrangeStage } from '../arrange/ArrangeStage.tsx';

export function useFrameScale(width: Width): number | null {
	const editor = useEditor();
	return useStore(editor.stageLayout, (layout) => (layout ? layout[width].scale : null));
}

export function Stage() {
	const editor = useEditor();
	const width = useStore(editor.view, (v) => v.width);
	const painted = useStore(editor.previewStatus, (s) => s.painted);
	const layout = useStore(editor.stageLayout);
	// The iframes' first load renders the file of the document opened with the page; later
	// documents are morphed in, so the src never changes (a change would reload the frame).
	// Site Settings has no page of its own (M5a): opened first, the stage shows Home's.
	const [src] = useState(() => previewSrc(editor.previewStatus.get().showing));
	// Edit in context (Decision 9): Site Settings shows over the last page, live and undimmed. Only without
	// a page under it (none to show) does the last page stay dimmed, with a way back (M5a's #settings).
	const overPage = useStore(editor.over, (o) => !!o);
	const settingsAside = useStore(editor.doc.state, (s) => s.document.kind === 'settings') && !overPage;
	// M5b: the library (browsing, not a slot's picker) has no page of its own either: the last page, dimmed, is its drop target.
	const library = useStore(editor.view, (v) => v.level === 'media' && !v.media?.pick);
	// M6: the inbox has no page either: the last page, dimmed, with a submission's sheet over it.
	const inbox = useStore(editor.view, (v) => v.level === 'submissions');
	// Pre-M7 polish: a flat collection's level shows its documents as a table, full width, in place of the preview.
	const tableOf = useTableCollection();
	// Arrange pages (Decision 16): the arrange screen takes the preview's place.
	const arrange = useStore(editor.view, (v) => v.level === 'arrange');
	const table = !!tableOf && !arrange;
	const aside = !table && !arrange && (settingsAside || library || inbox);
	const showing = useStore(editor.previewStatus, (s) => s.showing);
	const documents = useStore(editor.documents);
	const back = documents.find((d) => d.collection === showing.collection && d.path === showing.path);
	const backLabel = back?.label ?? 'Home';
	const stage = useRef<HTMLElement>(null);
	const iframes = useRef<Partial<Record<Width, HTMLIFrameElement | null>>>({});
	const [fading, setFading] = useState(false);

	useEffect(() => {
		const el = stage.current;
		if (!el) return;
		const measure = () => {
			if (el.clientWidth > 0 && el.clientHeight > 0) editor.stageLayout.set(stageLayout(el.clientWidth, el.clientHeight));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [editor]);

	useEffect(() => {
		const { desktop, tablet, phone } = iframes.current;
		if (!editor.preview || !desktop || !tablet || !phone) return;
		return editor.preview.attach({ desktop, tablet, phone });
	}, [editor]);

	useEffect(() => {
		if (!painted) return;
		setFading(true);
		const timer = setTimeout(() => setFading(false), 400);
		return () => clearTimeout(timer);
	}, [painted]);

	const className = ['stage', !painted && 'unpainted', fading && 'painting', aside && 'is-aside', table && 'is-table', arrange && 'is-arrange'].filter(Boolean).join(' ');
	return (
		<main ref={stage} className={className} id="stage" aria-label="Preview of the page" data-painted={painted ? 'true' : 'false'}>
			{/* Before the frames, as the mockup's: over the held page while a document has none of its own (Site Settings). */}
			<div className="stage-aside" id="stage-aside" inert={!aside} data-stage-aside={aside ? '' : undefined}>
				{inbox ? (
					<InboxStage back={backLabel} onBack={() => void editor.openDocument(showing)} />
				) : library ? (
					<LibraryStage back={backLabel} onBack={() => void editor.openDocument(showing)} />
				) : aside ? (
					<div className="in">
						<Icon name="gear" />
						<h2>Site Settings has no page of its own</h2>
						<button type="button" className="btn" data-act="back-to-page" onClick={() => void editor.openDocument(showing)}>
							<Icon name="chev-l" size="sm" />
							Back to {backLabel}
						</button>
					</div>
				) : null}
			</div>
			<div className="stage-table" inert={!table} data-stage-table={table ? '' : undefined}>
				{tableOf ? <CollectionTable collection={tableOf} /> : null}
			</div>
			{arrange ? <ArrangeStage /> : null}
			{WIDTHS.map((w) => {
				const box = layout?.[w];
				const on = w === width;
				return (
					<div
						key={w}
						className={`frame${on ? ' on' : ''}${w !== 'desktop' ? ' boxed' : ''}`}
						data-w={w}
						inert={!on}
						style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined}
					>
						<iframe
							inert={aside || table || arrange || undefined}
							ref={(el) => {
								iframes.current[w] = el;
							}}
							src={src}
							title={`Preview at ${WIDTH_LABEL[w]} width, ${TRUE_WIDTH[w]} pixels`}
							data-width={TRUE_WIDTH[w]}
							style={{
								width: `${TRUE_WIDTH[w]}px`,
								height: `${box ? box.iframeHeight : 900}px`,
								transform: box ? `scale(${box.scale})` : undefined,
							}}
						/>
					</div>
				);
			})}
		</main>
	);
}
