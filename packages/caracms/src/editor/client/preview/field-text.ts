/**
 * A plain text field's text as typed on the page (Decision 12; the line-break
 * rule: a break is `\n`, rendered `<br>`). Read from the DOM, not `innerText`:
 * innerText applies the site's CSS (`text-transform: uppercase` would store
 * capitals), and a contenteditable's spaces come back as no-break spaces.
 *
 * - a text node is its text (no-break spaces as spaces); a `<br>` is `\n`
 * - a block element the browser inserted (a `<div>` on Enter) starts a new line, and so
 *   does a line of the lines rendering (`[data-cms-line]`, M9 Decision 10)
 * - the trailing `<br>` a browser adds so an empty last line shows is dropped
 * - one line only: breaks become spaces
 */
const BLOCKS = new Set(['DIV', 'P', 'LI']);

export function fieldText(el: Element, multiline = true): string {
	let out = '';
	const walk = (node: Node) => {
		for (const child of node.childNodes) {
			if (child.nodeType === 3) out += (child as Text).data;
			else if (child.nodeType === 1) {
				const tag = (child as Element).tagName;
				if (tag === 'BR') out += '\n';
				else {
					if ((BLOCKS.has(tag) || (child as Element).hasAttribute('data-cms-line')) && out && !out.endsWith('\n')) out += '\n';
					walk(child);
				}
			}
		}
	};
	walk(el);
	out = out.replace(/ /g, ' ');
	if (out.endsWith('\n')) out = out.slice(0, -1);
	return multiline ? out : out.replace(/\n+/g, ' ');
}

/**
 * The text a field element shows for `text`: a lines-rendering field (`[data-cms-lines]`,
 * M9 Decision 10) trims each line and drops blank ones, as Text.astro does; any other field shows it all.
 */
export function shownText(el: Element, text: string): string {
	return el.hasAttribute('data-cms-lines') ? text.split('\n').map((line) => line.trim()).filter((line) => line !== '').join('\n') : text;
}

/**
 * Put a plain text field's text into its element as the render draws it. `\n` becomes
 * `<br>` (innerText's setter; the line-break rule), except in the lines rendering (M9
 * Decision 10): blank lines drop, one line is bare text, and two or more are a `<span>`
 * each with the component's `lineClass` and the `data-cms-line` marker.
 */
export function writeFieldText(el: HTMLElement, text: string): void {
	if (!el.hasAttribute('data-cms-lines')) {
		el.innerText = text;
		return;
	}
	const lines = shownText(el, text).split('\n').filter((line) => line !== '');
	if (lines.length <= 1) {
		el.textContent = lines[0] ?? '';
		return;
	}
	const doc = el.ownerDocument;
	const cls = el.getAttribute('data-cms-line-class');
	el.replaceChildren(
		...lines.map((line) => {
			const span = doc.createElement('span');
			if (cls) span.className = cls;
			span.setAttribute('data-cms-line', '');
			span.textContent = line;
			return span;
		}),
	);
}
