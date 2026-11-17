/**
 * Edit in context, Decision 1: the Shared blocks level lists its blocks grouped, Header, then
 * Footer, then the rest under their block types (in the config's order), and one with a
 * warning (a file that can't be read, a type the code doesn't know) last. Pure, for the unit
 * tests; the sidebar's list and the stage's table both group this way.
 *
 *   sharedGroups(site, rows)        the groups, each with its rows in the order given
 *   slotBlocks(documents, slot)     the usable shared blocks that fill a slot
 *   showsDefault(documents, doc)    whether a row gets the "Default" chip: its slot's default,
 *                                   once that slot has more than one block
 *   pickableSlots(documents, frame) Decision 3: the slots a document's form offers a picker for
 */
import { own } from '../../../document.ts';
import { SLOT_NAMES, type SlotName } from '../../../slots.ts';
import { titleCase } from '../../../fields.ts';
import type { EditorSite, ListedDocument } from '../../types.ts';

export interface SharedGroup {
	/** `header`, `footer`, a block type, or `problems`. */
	key: string;
	label: string;
	rows: ListedDocument[];
}

/** What the last group is called: blocks no page can show as they are. */
export const PROBLEMS_LABEL = 'Not shown on pages';

const usable = (site: Pick<EditorSite, 'blocks'>, d: ListedDocument) => !d.warning && !!d.blockType && !!own(site.blocks, d.blockType);

export function sharedGroups(site: Pick<EditorSite, 'blocks'>, rows: readonly ListedDocument[]): SharedGroup[] {
	const groups: SharedGroup[] = SLOT_NAMES.map((slot) => ({ key: slot, label: titleCase(slot), rows: rows.filter((d) => usable(site, d) && d.slot === slot) }));
	for (const [type, block] of Object.entries(site.blocks)) {
		if (block.slot) continue;
		groups.push({ key: type, label: block.label, rows: rows.filter((d) => usable(site, d) && !d.slot && d.blockType === type) });
	}
	groups.push({ key: 'problems', label: PROBLEMS_LABEL, rows: rows.filter((d) => !usable(site, d)) });
	return groups.filter((g) => g.rows.length > 0);
}

/** The shared blocks that fill `slot` and can be used. */
export function slotBlocks(documents: readonly ListedDocument[], slot: SlotName): ListedDocument[] {
	return documents.filter((d) => d.collection === 'shared' && !d.warning && d.slot === slot);
}

/** Decision 1: the "Default" chip marks a slot's default only once that slot has more than one block. */
export function showsDefault(documents: readonly ListedDocument[], doc: ListedDocument): boolean {
	return !!doc.slot && !!doc.default && slotBlocks(documents, doc.slot).length > 1;
}

/** Decision 3: a picker for each slot with more than one block, or one the document already picks (so it can be seen and cleared). */
export function pickableSlots(documents: readonly ListedDocument[], frame: Partial<Record<SlotName, string>> | undefined): SlotName[] {
	return SLOT_NAMES.filter((slot) => slotBlocks(documents, slot).length > 1 || frame?.[slot] !== undefined);
}
