/**
 * A tiny observable value: the editor's state containers are built on it, and
 * React reads them with `useStore` (context.tsx → useSyncExternalStore). Values are
 * replaced, never mutated, so a snapshot is stable until the next `set`.
 */
export interface Store<T> {
	get(): T;
	set(next: T | ((previous: T) => T)): void;
	/** Merge into an object value. */
	update(patch: Partial<T>): void;
	subscribe(listener: (value: T, previous: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
	let value = initial;
	const listeners = new Set<(value: T, previous: T) => void>();
	const store: Store<T> = {
		get: () => value,
		set(next) {
			const previous = value;
			value = typeof next === 'function' ? (next as (p: T) => T)(previous) : next;
			if (Object.is(value, previous)) return;
			for (const listener of [...listeners]) listener(value, previous);
		},
		update(patch) {
			store.set((previous) => {
				for (const key of Object.keys(patch) as (keyof T)[]) {
					if (!Object.is(previous[key], patch[key])) return { ...previous, ...patch };
				}
				return previous;
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return store;
}
