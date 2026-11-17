import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sidebarFrom } from '../../src/starlight-kit/sidebar.ts';
import { fakeReader } from './fake-reader.ts';

test('sections become groups opening with their own page, in the reader order; Home is left out', async () => {
	const read = fakeReader([
		{ path: 'index', title: 'Home' },
		{ path: 'getting-started', title: 'Getting Started' },
		{ path: 'getting-started/sign-up', title: 'Signing Up' },
		{ path: 'guides', title: 'Guides' },
		{ path: 'guides/writing-a-guide', title: 'Writing a Guide' },
		{ path: 'guides/adding-pictures-to-guides', title: 'Adding Pictures to Guides' },
		{ path: 'privacy', title: 'Privacy' },
	]);
	assert.deepEqual(await sidebarFrom(read), [
		{ label: 'Getting Started', items: [{ label: 'Getting Started', link: '/getting-started' }, { label: 'Signing Up', link: '/getting-started/sign-up' }] },
		{ label: 'Guides', items: [{ label: 'Guides', link: '/guides' }, { label: 'Writing a Guide', link: '/guides/writing-a-guide' }, { label: 'Adding Pictures to Guides', link: '/guides/adding-pictures-to-guides' }] },
		{ label: 'Privacy', link: '/privacy' },
	]);
});

test('a folder with no page is a group labelled like the editor labels it', async () => {
	const read = fakeReader([
		{ path: 'how-tos/first-post', title: 'First Post' },
		{ path: 'how-tos/second-post', title: 'Second Post' },
	]);
	assert.deepEqual(await sidebarFrom(read), [
		{ label: 'How tos', items: [{ label: 'First Post', link: '/how-tos/first-post' }, { label: 'Second Post', link: '/how-tos/second-post' }] },
	]);
});

test('a hidden page and the pages under it are left out', async () => {
	const read = fakeReader([
		{ path: 'guides', title: 'Guides' },
		{ path: 'guides/secret', title: 'Secret', hidden: true },
		{ path: 'drafts', title: 'Drafts', hidden: true },
		{ path: 'drafts/one', title: 'One' },
	]);
	assert.deepEqual(await sidebarFrom(read), [{ label: 'Guides', link: '/guides' }]);
});

test("the site's groupLabels label a folder with no page, nested ones too; a folder it doesn't name keeps the editor's label", async () => {
	const read = fakeReader([
		{ path: 'how-tos/first-post', title: 'First Post' },
		{ path: 'how-tos/advanced/third-post', title: 'Third Post' },
		{ path: 'faq/billing', title: 'Billing' },
	]);
	assert.deepEqual(await sidebarFrom(read, { groupLabels: { 'how-tos': 'How-To Guides', 'how-tos/advanced': 'Advanced' } }), [
		{ label: 'How-To Guides', items: [{ label: 'First Post', link: '/how-tos/first-post' }, { label: 'Advanced', items: [{ label: 'Third Post', link: '/how-tos/advanced/third-post' }] }] },
		{ label: 'Faq', items: [{ label: 'Billing', link: '/faq/billing' }] },
	]);
});

test('groupLabels never relabel a page of its own: a group with a page keeps the page title', async () => {
	const read = fakeReader([
		{ path: 'guides', title: 'Guides' },
		{ path: 'guides/one', title: 'One' },
	]);
	assert.deepEqual(await sidebarFrom(read, { groupLabels: { guides: 'Something Else' } }), [
		{ label: 'Guides', items: [{ label: 'Guides', link: '/guides' }, { label: 'One', link: '/guides/one' }] },
	]);
});
