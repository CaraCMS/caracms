// Edit in context, Acceptance 26: what the site skills teach (Decision 5). A text check on the skills' own words, for what a test can prove; whether the prose
// reads well is a person's call.
// - `caracms-blocks` has the where-content-lives table and teaches slots, `cms.settings` and the
//   valueless marking with the starter's code.
// - No skill gives an FAQ or logos as a pageless collection's example (the blocks skill says the
//   opposite; the tina skill's logo mentions are a converter's field-kind notes, not an example).
// - The preview rule is the JS-off page: no skill teaches `runSetups({ settled`, hidden content
//   shows by `[data-preview]` CSS, a layout-only script runs again on `caracms:rendered`.
// - `caracms-adopt` ends with the editor walk, its exceptions named.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../site-skills', import.meta.url));
const skills = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('caracms-')).map((e) => e.name);
const read = (name: string) => readFileSync(join(root, name, 'SKILL.md'), 'utf8');
const blocks = read('caracms-blocks');
const adopt = read('caracms-adopt');

describe('the site skills (Acceptance 26)', () => {
	test('caracms-blocks teaches where content lives, slots, source contexts and the valueless marking', () => {
		assert.match(blocks, /^## Where content lives$/m);
		for (const place of ['Shared', 'Site Settings', 'A collection', 'The block']) assert.ok(blocks.includes(place), place);
		assert.match(blocks, /slot: 'footer'/);
		assert.match(blocks, /slot: 'header'/);
		assert.match(blocks, /<Text cms=\{cms\.settings\} field="contact\.phone"/);
		assert.match(blocks, /<Block cms=\{cms\.settings\} field="contact\.email" as="a"/);
		assert.match(blocks, /a single footer|header or footer is a shared block even when the site has one/i);
	});

	test('no skill gives an FAQ or logos as a pageless collection\'s example', () => {
		assert.match(blocks, /An FAQ or a logo strip one block shows is that block's list/);
		assert.match(adopt, /An FAQ, a logo strip or a team grid\s+that one block shows becomes that block's `list\(\)`/);
		for (const name of ['caracms-blocks', 'caracms-adopt', 'caracms-content']) {
			assert.doesNotMatch(read(name), /pageless collection[^.\n]{0,80}\b(an? FAQ|logos|awards|a team)\b/i, name);
		}
		const tina = read('caracms-tina');
		assert.doesNotMatch(tina, /pageless[^.\n]{0,80}\b(an? FAQ|logos|awards|a team)\b/i);
	});

	test('the preview is the JS-off page: no settled path, hidden content shown by [data-preview], layout scripts run again on caracms:rendered', () => {
		for (const name of skills) {
			const text = read(name);
			assert.doesNotMatch(text, /runSetups\(\s*\{\s*settled/, `${name} teaches runSetups({ settled })`);
			assert.doesNotMatch(text, /ScrollTrigger\.refresh\(\)/, `${name} teaches ScrollTrigger.refresh()`);
		}
		assert.match(blocks, /\[data-preview\]/);
		assert.match(adopt, /\[data-preview\]/);
		assert.match(blocks, /caracms:rendered/);
	});

	test('caracms-adopt ends with the editor walk, its exceptions named', () => {
		const at = adopt.indexOf('**The editor walk**');
		assert.ok(at > 0, 'the walk is in section 10');
		const walk = adopt.slice(at);
		assert.match(walk, /click every visible word/);
		assert.match(walk, /scroll the whole page/);
		assert.match(walk, /a document's\s+title/);
		assert.match(walk, /"Read more"/);
		assert.match(walk, /not yet on slots/);
		// It is the last numbered step of the last section.
		assert.doesNotMatch(walk.slice(walk.indexOf('title (edited')), /\n\d+\. \*\*/);
	});
});
