/**
 * The editor in React: one context holding the editor (editor.ts), and `useStore`
 * to read any of its stores. A selector must return a stable value (a primitive, or
 * a part of the state as stored), never a new object, or React re-renders forever.
 *
 *   const editor = useEditor();
 *   const level = useStore(editor.view, (v) => v.level);
 *   const session = useStore(editor.doc.state);
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Editor } from './editor.ts';
import type { Store } from './state/store.ts';

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
	const editor = useContext(EditorContext);
	if (!editor) throw new Error('useEditor: no editor (render inside <EditorApp>)');
	return editor;
}

export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, select: (value: T) => S): S;
export function useStore<T, S>(store: Store<T>, select?: (value: T) => S): T | S {
	const read = () => (select ? select(store.get()) : store.get());
	return useSyncExternalStore((onChange) => store.subscribe(onChange), read, read);
}
