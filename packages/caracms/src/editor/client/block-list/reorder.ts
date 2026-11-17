/**
 * Reordering rows by drag and by keys (M2's keys rule): the block list's mechanism,
 * shared with M5a's list field (Decision 5: rows reorder "as blocks do").
 *
 * - `useRowDrag`: HTML drag and drop over a list of rows. The lifted row turns into
 *   a ghost a frame later (so the drag image is the real row); the drop lands before
 *   or after the row under the pointer, by its middle; the drop line is full width
 *   (the row's `drop-before` / `drop-after` class, never a side rail).
 * - `rowKeyAction`: what a key on a focused row does: ⌥↑/⌥↓ move it, ⌫ removes it,
 *   ↑/↓ move focus between rows.
 */
import { useState, type DragEvent, type KeyboardEvent } from 'react';

export interface RowDrag {
	key: string;
	/** Where it would land: before or after this row. */
	drop: { key: string; after: boolean } | null;
	/** The lifted row is drawn as a ghost (a frame later, so the drag image is the real row). */
	ghost: boolean;
}

export interface RowDragApi {
	drag: RowDrag | null;
	cancel(): void;
	/** On a row's `dragstart`. */
	start(event: DragEvent, key: string): void;
	/** On the list's `dragover`. */
	over(event: DragEvent): void;
	/** On the list's `drop`. Moves the dragged row by `onMove(key, toIndex)`. */
	drop(event: DragEvent): void;
	/** The row's drag classes: `is-ghost`, `drop-before`, `drop-after`. */
	classes(key: string): string;
}

export function useRowDrag(options: {
	/** The row element an event is in (its key read by `keyOf`), or null. */
	rowOf: (target: Element) => HTMLElement | null;
	keyOf: (row: HTMLElement) => string;
	indexOf: (key: string) => number;
	onMove: (key: string, to: number) => void;
	onStart?: () => void;
}): RowDragApi {
	const [drag, setDrag] = useState<RowDrag | null>(null);
	return {
		drag,
		cancel: () => setDrag(null),
		start(event, key) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', key);
			options.onStart?.();
			setDrag({ key, drop: null, ghost: false });
			requestAnimationFrame(() => setDrag((d) => (d && d.key === key ? { ...d, ghost: true } : d)));
		},
		over(event) {
			if (!drag) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = 'move';
			const row = options.rowOf(event.target as Element);
			if (!row) return;
			const box = row.getBoundingClientRect();
			const drop = { key: options.keyOf(row), after: event.clientY - box.top > box.height / 2 };
			if (drag.drop?.key !== drop.key || drag.drop.after !== drop.after) setDrag({ ...drag, drop });
		},
		drop(event) {
			if (!drag?.drop) return;
			event.preventDefault();
			const from = options.indexOf(drag.key);
			let to = options.indexOf(drag.drop.key) + (drag.drop.after ? 1 : 0);
			if (from < to) to -= 1;
			setDrag(null);
			options.onMove(drag.key, to);
		},
		classes(key) {
			if (!drag) return '';
			const lifted = drag.key === key;
			return [lifted && drag.ghost ? 'is-ghost' : '', drag.drop?.key === key && !lifted ? (drag.drop.after ? 'drop-after' : 'drop-before') : ''].filter(Boolean).join(' ');
		},
	};
}

export type RowKeyAction = { kind: 'move'; to: number } | { kind: 'remove' } | { kind: 'focus'; to: number } | null;

/**
 * A key on a focused row at `index` of `count` (M2's keys rule): ⌥↑/⌥↓ move it,
 * ⌫ (or Delete) removes it, ↑/↓ move focus. Calls preventDefault for what it takes.
 * Null for any other key, or a move or focus past either end.
 */
export function rowKeyAction(event: KeyboardEvent, index: number, count: number): RowKeyAction {
	if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
		event.preventDefault();
		const to = index + (event.key === 'ArrowUp' ? -1 : 1);
		return to < 0 || to >= count ? null : { kind: 'move', to };
	}
	if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey) {
		event.preventDefault();
		return { kind: 'remove' };
	}
	if (!event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
		const to = index + (event.key === 'ArrowDown' ? 1 : -1);
		if (to < 0 || to >= count) return null;
		event.preventDefault();
		return { kind: 'focus', to };
	}
	return null;
}
