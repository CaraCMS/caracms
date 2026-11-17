import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILE_TYPES, fileAddress, fileKeyOf, fileLinkBehaviour, fileTypeOf, isFileKey, isFileLink } from '../src/files.ts';

const PDF = 'uploads/3f9c2a7b0e41/rate-card-2026.pdf';

test('the table holds Decision 1’s types, PDF the only one that opens in a tab', () => {
	assert.deepEqual(FILE_TYPES.map((t) => t.ext), ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'csv', 'zip']);
	assert.deepEqual(FILE_TYPES.filter((t) => t.opensInTab).map((t) => t.ext), ['pdf']);
	assert.equal(fileTypeOf('x.DOCX')?.label, 'Word');
	assert.equal(fileTypeOf('x.jpg'), null);
});

test('isFileKey takes only a file key’s exact shape', () => {
	assert.equal(isFileKey(PDF), true);
	assert.equal(isFileKey('uploads/3f9c2a7b0e41/café.csv'), true);
	for (const bad of [
		'uploads/3f9c2a7b0e41/photo.jpg', // an image
		'submissions/3f9c2a7b0e41/a.pdf',
		'uploads/3F9C2A7B0E41/a.pdf', // upper-case hash
		'uploads/3f9c2a7b0e4/a.pdf', // short hash
		'uploads/3f9c2a7b0e41/a/b.pdf',
		'uploads/3f9c2a7b0e41/.pdf',
		'uploads/3f9c2a7b0e41/a\\b.pdf',
		'uploads/3f9c2a7b0e41/a\u0000.pdf',
		'uploads/3f9c2a7b0e41/a.exe',
	]) assert.equal(isFileKey(bad), false, bad);
});

test('an address and its key round-trip, encoded per segment, with ?download', () => {
	assert.equal(fileAddress(PDF), '/files/3f9c2a7b0e41/rate-card-2026.pdf');
	assert.equal(fileAddress(PDF, { download: true }), '/files/3f9c2a7b0e41/rate-card-2026.pdf?download');
	const accented = 'uploads/3f9c2a7b0e41/café-menu.pdf';
	assert.equal(fileAddress(accented), '/files/3f9c2a7b0e41/caf%C3%A9-menu.pdf');
	assert.deepEqual(fileKeyOf(fileAddress(accented)), { key: accented, download: false });
	assert.deepEqual(fileKeyOf('/files/3f9c2a7b0e41/rate-card-2026.pdf?download#p2'), { key: PDF, download: true });
	assert.throws(() => fileAddress('uploads/3f9c2a7b0e41/photo.jpg'));
});

test('fileKeyOf refuses anything that isn’t a file link', () => {
	for (const bad of [
		'/brochure.pdf',
		'/files/3f9c2a7b0e41/a.pdf?x=1',
		'/files/3f9c2a7b0e41/a.pdf?download&x=1',
		'/files/3f9c2a7b0e41/a.pdf?',
		'/files/3f9c2a7b0e41/a%2fb.pdf',
		'/files/3f9c2a7b0e41/a%E0%A4%A.pdf',
		'/files/3f9c2a7b0e41/../a.pdf',
		'/files/3f9c2a7b0e41/photo.jpg',
		'https://example.com/files/3f9c2a7b0e41/a.pdf',
		null,
	]) assert.equal(fileKeyOf(bad), null, String(bad));
	assert.equal(isFileLink('/files/3f9c2a7b0e41/a.pdf'), true);
});

test('fileLinkBehaviour: a PDF opens in a new tab unless ?download; other files download; other links are null', () => {
	assert.equal(fileLinkBehaviour('/files/3f9c2a7b0e41/a.pdf'), 'new-tab');
	assert.equal(fileLinkBehaviour('/files/3f9c2a7b0e41/a.pdf?download'), 'download');
	assert.equal(fileLinkBehaviour('/files/3f9c2a7b0e41/a.docx'), 'download');
	assert.equal(fileLinkBehaviour('/about'), null);
	assert.equal(fileLinkBehaviour('/brochure.pdf'), null);
});
