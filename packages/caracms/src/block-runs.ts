/**
 * Runs of blocks (M9 Decision 9): the page component tells `<Blocks>` which neighbouring
 * blocks go together and what's drawn round them, such as a band holding cards, each card
 * holding several blocks (a Tina template's About page).
 *
 *   <Blocks document={document} collection={collection} preview={preview} wrap={cardRuns} />
 *
 *   // The page component's own rule, from the blocks' data:
 *   const cardRuns: WrapBlocks = (blocks) => …[{ from: 2, to: 6, component: Band, runs: [
 *     { from: 2, to: 4, component: Card, props: { id: 'story' } },
 *     { from: 5, to: 6, component: Card, props: { id: 'team' } },
 *   ] }];
 *
 * - `wrap` gets the blocks that render, in order: each one's document index, type and render
 *   data (what its component gets as `block`), so the rule can read a field (`card`, `anchor`).
 * - A run is `from`..`to`, document indices, inclusive: everything between renders inside it,
 *   a skipped block's preview marker included. Its `component` is drawn round the run with
 *   `props`, the blocks in its default slot. `runs` are runs inside it (the cards in a band),
 *   each within it.
 * - Runs are in order and don't overlap. A rule that breaks that is a mistake in the site's
 *   code, so the render stops with a sentence saying which runs.
 * - Nothing about each block changes: its index, its context (`index`, `first`, `h1Field`,
 *   `eager`), its markers in a preview, so it's selected, typed into and morphed there as
 *   anywhere else. A wrapper carries no markers: it's the site's markup.
 */

/** A block as `wrap` sees it. */
export interface WrapBlock {
	/** Its index in the document (the editor's index, `cms.index`). */
	index: number;
	type: string;
	/** Its render data: what its component gets as `block`. */
	data: Record<string, unknown>;
}

/** A run of blocks and what's drawn round it. */
export interface BlockRun {
	/** The first block's document index. */
	from: number;
	/** The last block's document index (inclusive). */
	to: number;
	/** An Astro component (or any component Astro renders): the run goes in its default slot. */
	component: unknown;
	props?: Record<string, unknown>;
	/** Runs inside this one, each within `from`..`to`. */
	runs?: readonly BlockRun[];
}

/** The page component's rule: the runs, from the blocks that render. */
export type WrapBlocks = (blocks: readonly WrapBlock[]) => readonly BlockRun[];

/** What `<Blocks>` draws, as a tree: an entry (by document index), or a run holding more. */
export type RunNode = { kind: 'entry'; index: number } | { kind: 'run'; component: unknown; props: Record<string, unknown>; children: RunNode[] };

const named = (run: BlockRun) => `the run ${run.from}–${run.to}`;

/**
 * The document's entries (`indices`, in order: every block the render has an entry for)
 * grouped by `runs`. Throws on runs out of order, overlapping, outside their parent, or
 * with `from` after `to`.
 */
export function runTree(indices: readonly number[], runs: readonly BlockRun[]): RunNode[] {
	const place = (within: readonly number[], level: readonly BlockRun[], parent: BlockRun | null): RunNode[] => {
		let previous: BlockRun | null = null;
		for (const run of level) {
			if (!Number.isInteger(run.from) || !Number.isInteger(run.to) || run.from > run.to) throw new Error(`<Blocks wrap>: ${named(run)} needs whole-number indices with from at or before to.`);
			if (!run.component) throw new Error(`<Blocks wrap>: ${named(run)} has no component to draw round it.`);
			if (previous && run.from <= previous.to) throw new Error(`<Blocks wrap>: ${named(run)} starts before ${named(previous)} ends. Runs are in document order and don't overlap.`);
			if (parent && (run.from < parent.from || run.to > parent.to)) throw new Error(`<Blocks wrap>: ${named(run)} isn't inside ${named(parent)}, which holds it.`);
			previous = run;
		}
		const out: RunNode[] = [];
		let i = 0;
		for (const run of level) {
			while (i < within.length && within[i]! < run.from) out.push({ kind: 'entry', index: within[i++]! });
			const inside: number[] = [];
			while (i < within.length && within[i]! <= run.to) inside.push(within[i++]!);
			out.push({ kind: 'run', component: run.component, props: run.props ?? {}, children: place(inside, run.runs ?? [], run) });
		}
		while (i < within.length) out.push({ kind: 'entry', index: within[i++]! });
		return out;
	};
	return place(indices, runs, null);
}
