/**
 * The editor's browser entry: hydrate the server-rendered shell (Decision 2) from
 * the props the admin route left in the page.
 */
import { hydrateRoot } from 'react-dom/client';
import type { AdminProps } from '../types.ts';
import { createEditor } from './editor.ts';
import { EditorApp } from './shell/App.tsx';

const props = JSON.parse(document.getElementById('caracms-props')!.textContent!) as AdminProps;
const editor = createEditor(props, { client: true });
hydrateRoot(document.getElementById('viewport')!, <EditorApp editor={editor} />);
