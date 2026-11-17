/** The shell's server render (Decision 2): the chrome is in the HTML before any script runs. */
import { renderToString } from 'react-dom/server';
import { createEditor } from '../client/editor.ts';
import { EditorApp } from '../client/shell/App.tsx';
import type { AdminProps } from '../types.ts';

export function renderEditor(props: AdminProps): string {
	return renderToString(<EditorApp editor={createEditor(props, { client: false })} />);
}
