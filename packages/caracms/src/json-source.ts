/**
 * A JSON parser that remembers where every value sits in the source text, so the
 * serializer can copy untouched values back byte for byte (Decision 7).
 *
 * Validity is JSON.parse's: the text is checked with it first, so error messages
 * are the platform's and nothing this parser accepts is invalid JSON.
 */

export type JsonNode = ObjectNode | ArrayNode | ScalarNode;

interface Span {
	/** Offset of the value's first character. */
	start: number;
	/** Offset just past its last character. */
	end: number;
}

export interface ObjectNode extends Span {
	kind: 'object';
	members: MemberNode[];
}

export interface MemberNode {
	key: string;
	value: JsonNode;
}

export interface ArrayNode extends Span {
	kind: 'array';
	items: JsonNode[];
}

export interface ScalarNode extends Span {
	kind: 'scalar';
	value: string | number | boolean | null;
}

export interface ParsedSource {
	text: string;
	root: JsonNode;
	/** The plain value, as JSON.parse gives it. */
	value: unknown;
}

export function parseSource(text: string): ParsedSource {
	const value = JSON.parse(text);
	let i = 0;

	const ws = () => {
		while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
	};

	const string = (): string => {
		const start = i;
		i++; // opening quote
		while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
		i++; // closing quote
		return JSON.parse(text.slice(start, i)) as string;
	};

	const node = (): JsonNode => {
		ws();
		const start = i;
		const c = text[i];
		if (c === '{') {
			i++;
			const members: MemberNode[] = [];
			ws();
			if (text[i] === '}') {
				i++;
				return { kind: 'object', start, end: i, members };
			}
			for (;;) {
				ws();
				const key = string();
				ws();
				i++; // ':'
				members.push({ key, value: node() });
				ws();
				if (text[i++] === '}') return { kind: 'object', start, end: i, members };
			}
		}
		if (c === '[') {
			i++;
			const items: JsonNode[] = [];
			ws();
			if (text[i] === ']') {
				i++;
				return { kind: 'array', start, end: i, items };
			}
			for (;;) {
				items.push(node());
				ws();
				if (text[i++] === ']') return { kind: 'array', start, end: i, items };
			}
		}
		if (c === '"') {
			const s = string();
			return { kind: 'scalar', start, end: i, value: s };
		}
		// number, true, false, null
		while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
		return { kind: 'scalar', start, end: i, value: JSON.parse(text.slice(start, i)) };
	};

	const root = node();
	return { text, root, value };
}

/** The last member with this key (JSON.parse's rule for duplicate keys). */
export function member(node: ObjectNode, key: string): MemberNode | undefined {
	for (let k = node.members.length - 1; k >= 0; k--) if (node.members[k]!.key === key) return node.members[k];
	return undefined;
}

export const slice = (source: ParsedSource, node: JsonNode) => source.text.slice(node.start, node.end);
