/**
 * The ref names behind each branch role (M9 Decision 6). `main` is what's published
 * (and deployed); `drafts` is where autosaves land. `CARACMS_MAIN_BRANCH` and
 * `CARACMS_DRAFTS_BRANCH` name them (mode.ts), defaulting to `main` and `drafts`.
 * With both named, a branch called `main` is never read or moved.
 *
 * Only the backends (backend.ts) turn a role into a name; everything above them speaks
 * in roles. No imports here, so mode.ts can read it without the backends.
 */

/** A branch's role, not its name. */
export type Branch = 'main' | 'drafts';

export interface BranchNames {
	main: string;
	drafts: string;
}

export const DEFAULT_BRANCHES: Readonly<BranchNames> = Object.freeze({ main: 'main', drafts: 'drafts' });
