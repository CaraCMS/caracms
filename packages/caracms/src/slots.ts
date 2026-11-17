/**
 * Edit in context, Decisions 2 and 3: which shared block fills a slot of a page's frame
 * (`header`, `footer`), and what's wrong when it can't be the one asked for. The slot
 * component (components/Slot.astro) draws what this picks; `caracms validate` reports the
 * same problems; the editor can read them too.
 *
 * - **The pick**, a page's `frame.<slot>`, is used when it names a shared block of a type
 *   the code knows that fills that slot. A pick that's missing, of an unknown type, or not of
 *   this slot (the other slot's, or a body block's) falls back to the default, with a warning
 *   naming the pick.
 * - **The default** is the shared block of that slot with `"default": true`. With two, the first
 *   by path wins, with a warning. With none (or an unusable one), the slot draws nothing, with a
 *   warning.
 *
 * Browser-safe, no imports beyond types (`warnOnce` writes to the console).
 */
/** Edit in context, Decision 2: the slots of a page's frame a shared block can fill. */
export const SLOT_NAMES = ['header', 'footer'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** A shared block as the slot rules need it. */
export interface SlotCandidate {
	/** Its path in the shared collection. */
	path: string;
	/** Its title, for messages. */
	title: string;
	/** Its block's type (`''` when it has none). */
	type: string;
	/** The slot its type fills, when the code knows the type and it fills one. */
	slot?: SlotName;
	/** Whether the code knows its type. */
	known: boolean;
	default: boolean;
}

export type SlotProblem = 'missing' | 'unknown-type' | 'not-this-slot' | 'two-defaults' | 'no-default' | 'default-unusable';

export interface SlotWarning {
	problem: SlotProblem;
	message: string;
}

export interface SlotResolution {
	/** The shared block that fills the slot, or null when nothing usable does. */
	path: string | null;
	/** Whether it's the page's own pick (else the default). */
	picked: boolean;
	warnings: SlotWarning[];
}

const named = (c: SlotCandidate) => (c.title ? `"${c.title}"` : `"${c.path}"`);

/** A slot block's usable for `slot`: known, and filling that slot. */
const fills = (c: SlotCandidate | undefined, slot: SlotName) => !!c && c.known && c.slot === slot;

/** The default for `slot` among `shared`, and any warning about it. */
export function slotDefault(slot: SlotName, shared: readonly SlotCandidate[]): { path: string | null; warnings: SlotWarning[] } {
	const defaults = shared.filter((c) => c.default && (c.slot === slot || !c.known)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const ofSlot = defaults.filter((c) => fills(c, slot));
	const warnings: SlotWarning[] = [];
	if (ofSlot.length > 1) {
		warnings.push({ problem: 'two-defaults', message: `${ofSlot.map(named).join(' and ')} are each the default ${slot}; the first by path (${named(ofSlot[0]!)}) is used. Make one the default.` });
	}
	if (ofSlot.length) return { path: ofSlot[0]!.path, warnings };
	const unusable = defaults[0];
	if (unusable) warnings.push({ problem: 'default-unusable', message: `The default ${slot}, ${named(unusable)}, is a block type the code doesn't know ("${unusable.type}"), so pages that don't pick a ${slot} draw none.` });
	else warnings.push({ problem: 'no-default', message: `There's no default ${slot}, so pages that don't pick a ${slot} draw none.` });
	return { path: null, warnings };
}

/** What fills `slot` on a page whose pick is `pick` (undefined: none). */
export function resolveSlot(slot: SlotName, pick: string | undefined, shared: readonly SlotCandidate[]): SlotResolution {
	const warnings: SlotWarning[] = [];
	if (pick !== undefined) {
		const found = shared.find((c) => c.path === pick);
		if (fills(found, slot)) return { path: pick, picked: true, warnings };
		const fallback = slotDefault(slot, shared);
		const then = fallback.path ? `so it gets the default ${slot}` : `and there's no default ${slot}, so it draws none`;
		if (!found) warnings.push({ problem: 'missing', message: `The page picks the ${slot} "${pick}", which isn't a shared block, ${then}.` });
		else if (!found.known) warnings.push({ problem: 'unknown-type', message: `The page picks the ${slot} ${named(found)}, a block type the code doesn't know ("${found.type}"), ${then}.` });
		else warnings.push({ problem: 'not-this-slot', message: `The page picks the ${slot} ${named(found)}, which ${found.slot ? `is a ${found.slot}` : "isn't a " + slot}, ${then}.` });
		return { path: fallback.path, picked: false, warnings: [...warnings, ...(fallback.path ? fallback.warnings : fallback.warnings.filter((w) => w.problem === 'two-defaults'))] };
	}
	const fallback = slotDefault(slot, shared);
	return { path: fallback.path, picked: false, warnings: fallback.warnings };
}

/** Edit in context, Decision 2: a body entry naming a slot's block is skipped on the page (kept in the file). */
export function slotEntryMessage(name: string, slot: SlotName): string {
	return `${name} is the page's ${slot}, so it isn't a block of the body. Skipped on the page; kept in the file.`;
}

const warned = new Set<string>();
/** A slot's warning on the server's console, once per process (every render of every page would repeat it). */
export function warnOnce(message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(message);
}
