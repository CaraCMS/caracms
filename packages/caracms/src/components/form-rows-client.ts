/**
 * A rows field's script (form rows Decision 12), apart from the form's own (form-client.ts) so a form
 * without a rows field keeps its one small inline script: Form.astro carries this only on a form that
 * has a rows field. It enhances a form that already works without it (one row, which posts):
 *
 * - a rows field (`[data-caracms-rows]`) gets its "Add another", up to its `data-max`, then its at-most
 *   line in the button's place; a Remove on each row from the second;
 * - its rows renumbered (names `<field>[<i>][<column>]`, ids, the row's number) so they post in order;
 *   added rows' controls are never `required` (a blank row is dropped by the server);
 * - a narrowed column (`data-from`) offers, in its row, the choices the picked document allows
 *   (`data-allowed`), or `data-else` before a pick, keeping its value while it's still allowed, else
 *   taking the first allowed.
 *
 * On an editor's preview page it does nothing, as the form's own script does.
 */

/** The editor's preview page (types.ts → PREVIEW_MARK). */
const PREVIEW_MARK = 'data-caracms-preview';

/** One option of a select as rendered: the narrowed column's full list, kept to rebuild from. */
interface Choice {
	value: string;
	label: string;
}

/** Form rows Decision 6: narrow a row's narrowed columns to what its pick allows (`else` before a pick). */
function narrowRow(row: HTMLElement, all: Map<string, Choice[]>): void {
	for (const select of row.querySelectorAll<HTMLSelectElement>('select[data-from]')) {
		const column = select.dataset.column ?? '';
		const choices = all.get(column);
		if (!choices) continue;
		const picked = row.querySelector<HTMLSelectElement>(`select[data-column="${CSS.escape(select.dataset.from ?? '')}"]`)?.value ?? '';
		let allowed: string[] = [];
		try {
			const map = JSON.parse(select.dataset.allowed || '{}') as Record<string, string[]>;
			const fallback = JSON.parse(select.dataset.else || '[]') as string[];
			allowed = picked && Object.hasOwn(map, picked) ? map[picked]! : fallback;
		} catch {
			allowed = choices.map((c) => c.value);
		}
		const offered = choices.filter((c) => allowed.includes(c.value));
		const keep = offered.some((c) => c.value === select.value) ? select.value : (offered[0]?.value ?? '');
		select.replaceChildren(
			...offered.map((c) => {
				const option = document.createElement('option');
				option.value = c.value;
				option.textContent = c.label;
				return option;
			}),
		);
		select.value = keep;
	}
}

/** Form rows Decision 12: a rows field's Add, Remove, numbering and narrowing (see above). */
function enhanceRows(form: HTMLFormElement): void {
	for (const field of form.querySelectorAll<HTMLElement>('[data-caracms-rows]')) {
		const list = field.querySelector<HTMLElement>('.cms-form-row-list');
		const first = list?.querySelector<HTMLElement>('[data-caracms-row]');
		const add = field.querySelector<HTMLButtonElement>('[data-caracms-add]');
		const atMost = field.querySelector<HTMLElement>('[data-caracms-at-most]');
		if (!list || !first || !add || !atMost) continue;
		const name = field.dataset.caracmsRows ?? '';
		const max = Math.max(1, Number(field.dataset.max) || 1);
		const removeWord = field.dataset.remove || 'Remove';
		const rowWord = field.dataset.rowWord || 'Row';
		// Every narrowed column's full list, as rendered (each choice the config has).
		const all = new Map<string, Choice[]>();
		for (const select of first.querySelectorAll<HTMLSelectElement>('select[data-from]')) {
			all.set(select.dataset.column ?? '', [...select.options].map((o) => ({ value: o.value, label: o.textContent ?? '' })));
		}
		// An added row: the first as rendered, emptied, nothing in it required.
		const blank = first.cloneNode(true) as HTMLElement;
		for (const control of blank.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
			control.removeAttribute('required');
			control.removeAttribute('aria-invalid');
			if (control instanceof HTMLInputElement) {
				control.value = '';
				control.removeAttribute('value');
			} else {
				for (const option of control.options) option.removeAttribute('selected');
				control.selectedIndex = 0;
			}
		}
		const rows = () => [...list.querySelectorAll<HTMLElement>(':scope > [data-caracms-row]')];
		const base = (first.querySelector<HTMLElement>('.cms-form-row-label')?.id ?? '').replace(/-0-label$/, '');
		const renumber = () => {
			rows().forEach((row, i) => {
				const label = row.querySelector<HTMLElement>('.cms-form-row-label');
				if (label) label.id = `${base}-${i}-label`;
				row.setAttribute('aria-labelledby', `${base}-${i}-label`);
				const n = row.querySelector<HTMLElement>('[data-caracms-row-n]');
				if (n) n.textContent = String(i + 1);
				for (const cell of row.querySelectorAll<HTMLElement>('.cms-form-cell')) {
					const column = cell.dataset.column ?? '';
					const id = `${base}-${i}-${column}`;
					const control = cell.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
					if (control) {
						control.id = id;
						control.name = `${name}[${i}][${column}]`;
						control.setAttribute('aria-describedby', [cell.querySelector('.cms-form-prefix') ? `${id}-prefix` : '', `${id}-error`].filter(Boolean).join(' '));
					}
					cell.querySelector('label')?.setAttribute('for', id);
					const prefix = cell.querySelector<HTMLElement>('.cms-form-prefix');
					if (prefix) prefix.id = `${id}-prefix`;
					const error = cell.querySelector<HTMLElement>('.cms-form-error');
					if (error) error.id = `${id}-error`;
				}
				const remove = row.querySelector<HTMLButtonElement>('.cms-form-row-remove');
				remove?.setAttribute('aria-label', `${removeWord} ${rowWord} ${i + 1}`);
			});
			const full = rows().length >= max;
			add.hidden = full;
			atMost.hidden = !full;
		};
		const addRow = () => {
			if (rows().length >= max) return;
			const row = blank.cloneNode(true) as HTMLElement;
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'cms-form-row-remove';
			remove.textContent = removeWord;
			remove.addEventListener('click', () => {
				const at = rows().indexOf(row);
				row.remove();
				renumber();
				const left = rows();
				(left[Math.min(at, left.length - 1)]?.querySelector<HTMLElement>('input, select') ?? add).focus();
			});
			row.append(remove);
			list.append(row);
			narrowRow(row, all);
			renumber();
			row.querySelector<HTMLElement>('input, select')?.focus();
		};
		add.addEventListener('click', addRow);
		list.addEventListener('change', (event) => {
			const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-caracms-row]');
			if (row && (event.target as HTMLElement).matches('select:not([data-from])')) narrowRow(row, all);
		});
		form.addEventListener('reset', () => {
			for (const row of rows().slice(1)) row.remove();
			// After the reset has put the first row's controls back.
			setTimeout(() => {
				narrowRow(first, all);
				renumber();
			});
		});
		narrowRow(first, all);
		renumber();
	}
}

export function initFormRows(): void {
	if (document.documentElement.hasAttribute(PREVIEW_MARK)) return;
	for (const form of document.querySelectorAll<HTMLFormElement>('form[data-caracms-form]')) {
		if (form.dataset.caracmsRowsReady) continue;
		form.dataset.caracmsRowsReady = '1';
		enhanceRows(form);
	}
}
