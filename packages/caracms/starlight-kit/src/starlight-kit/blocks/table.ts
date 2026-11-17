/**
 * The docs kit's table: a header row, then rows of cells. Scrolls sideways when it's wider
 * than the screen.
 *
 * Stored:
 *   { "type": "table",
 *     "header": [[{ "p": "Type" }], [{ "p": "Max size" }]],
 *     "rows": [{ "cells": [[{ "p": "JPEG" }], [{ "p": "10 MB" }]] }] }
 *
 * Every cell is a rich-text value with no headings. A row is `{ cells }` because caracms
 * refuses a bare list of lists. Rows can have fewer or more cells than the header: the
 * render pads short rows, and a Markdown writer pads both to the widest.
 */
import { list, richText, type BlockConfig, type BlockData } from 'caracms/config';

export const tableBlock = {
	label: 'Table',
	component: 'src/starlight-kit/blocks/Table.astro',
	fields: {
		header: list(richText({ label: 'Heading cell' }), { label: 'Header row', itemNoun: 'column' }),
		rows: list({ cells: list(richText({ label: 'Cell' }), { label: 'Cells', itemNoun: 'cell' }) }, { label: 'Rows', itemNoun: 'row' }),
	},
} satisfies BlockConfig;

export type TableData = BlockData<typeof tableBlock.fields>;
