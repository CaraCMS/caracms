// buttons({ allowNoLink: true }) (the editor-friction batch, item 4): a button
// with words and no link is meant, so it isn't half a button; without the option, nothing
// changes. The render half is the starter's (test/columns-render.test.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buttons, fieldWarnings, resolveSite, type Field } from '../src/config.ts';
import { siteRoot, variant } from './helpers/site.ts';

const styles = ['primary', 'secondary'] as const;
const codes = (field: Field, value: unknown) => fieldWarnings(field, value).map((w) => [w.path, w.code]);

describe('buttons({ allowNoLink })', () => {
	test('the option is set only when true', () => {
		assert.equal(buttons({ styles, allowNoLink: true }).allowNoLink, true);
		assert.equal('allowNoLink' in buttons({ styles }), false);
		assert.equal('allowNoLink' in buttons({ styles, allowNoLink: false }), false);
	});

	test('with it, words and no link are fine; a link with no words is still half a button', () => {
		const field = buttons({ styles, allowNoLink: true });
		assert.deepEqual(codes(field, [{ label: 'Coming soon', href: '', style: 'primary' }]), []);
		assert.deepEqual(codes(field, [{ label: '', href: '/contact', style: 'primary' }]), [['0', 'half-link']]);
		assert.deepEqual(codes(field, [{ label: 'Bad', href: 'nope', style: 'primary' }]).map(([, c]) => c), ['link-rule'], 'a link that fails the rule is still said');
	});

	test('without it, words and no link are half a button, as before', () => {
		assert.deepEqual(codes(buttons({ styles }), [{ label: 'Coming soon', href: '', style: 'primary' }]), [['0', 'half-link']]);
	});

	test('the config takes true or nothing', () => {
		const withField = (f: unknown) => variant({ blocks: { x: { component: 'Block.astro', fields: { f: f as Field } } } });
		assert.doesNotThrow(() => resolveSite(withField(buttons({ styles, allowNoLink: true })), siteRoot));
		assert.throws(() => resolveSite(withField({ ...buttons({ styles }), allowNoLink: 'yes' }), siteRoot), /allowNoLink is true or left out/);
	});
});
