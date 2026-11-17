/**
 * The signed-in person, handed from the sign-in guard to the editor's routes
 * (M4 Phases 2 and 3). The guard (Phase 3's middleware) checks the session on every
 * `/admin` and `/_caracms/` request in live mode and, when it passes, records the
 * person here; a route reads it back. In local mode nothing is recorded: there's no
 * sign-in (Decision 1).
 *
 * It rides on Astro's `context.locals`, under one key, so the package needs no
 * global `App.Locals` declaration in the site.
 */
import type { Person } from './messages.ts';

const KEY = '__caracms_person';

type Locals = object;

export function setPerson(locals: Locals, person: Person): void {
	(locals as Record<string, unknown>)[KEY] = person;
}

/** The person the guard let through, or null (local mode, or no guard ran). */
export function personOf(locals: Locals): Person | null {
	return ((locals as Record<string, unknown>)[KEY] as Person | undefined) ?? null;
}
