/**
 * The stage under the library (M5b; the mockup's #library and #library-image): the last
 * page stays, dimmed (shell/Stage.tsx), and this sits over it: the big drop target for
 * images, clips and files, or, on an image's own level, the whole picture, large; on a
 * file's (M6c G4, the mockup's #file), its type tile, large, with Open in a new tab.
 */
import { fileAddress, isFileKey } from '../../../files.ts';
import { useEditor, useStore } from '../context.tsx';
import { useDrop } from '../fields/MediaField.tsx';
import { FileTile, UploadButton } from '../pane/levels/MediaLevel.tsx';
import { Icon } from '../shell/Icons.tsx';
import { clipId, clipStill, fileSize, mediaFor } from './store.ts';

const TAKES = 'JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG';

export function LibraryStage({ back, onBack }: { back: string; onBack: () => void }) {
	const editor = useEditor();
	const media = mediaFor(editor);
	const item = useStore(editor.view, (v) => v.media?.item ?? null);
	const images = useStore(media.images, (l) => l.list);
	const clips = useStore(media.clips, (l) => l.list);
	const files = useStore(media.files, (l) => l.list);
	const drop = useDrop((list) => media.upload(list));
	const file = item && isFileKey(item) ? files?.find((f) => f.key === item) : null;
	if (file) {
		return (
			<div className="stage-lb" data-file-stage="">
				<FileTile type={file.type} size="lg" />
				<h2>{file.name}</h2>
				<p className="fine">
					{file.type}
					{file.bytes !== null ? ` · ${fileSize(file.bytes)}` : ''}
				</p>
				<a className="btn" href={fileAddress(file.key)} target="_blank" rel="noopener">
					<Icon name="ext" size="sm" />
					Open in a new tab
				</a>
			</div>
		);
	}
	if (item) {
		const image = images?.find((x) => x.key === item);
		const clip = clips?.find((c) => clipId(c) === item);
		const x = image ?? clip;
		if (x) {
			const ratio = x.w && x.h ? (x.w / x.h).toFixed(4) : '1.5';
			const src = image ? image.thumbnail2x : clip?.playbackId ? clipStill(clip.playbackId, 0, 1280) : null;
			return (
				<div className="stage-lb">
					<span className="ph" style={{ ['--r' as string]: ratio }}>
						{src ? <img className="ph-img" src={src} alt="" /> : null}
					</span>
					<p className="cap">
						<b>{image ? image.name : (clip?.title ?? 'A clip')}</b>
						{x.w && x.h ? ` · ${x.w} × ${x.h}` : ''}
					</p>
				</div>
			);
		}
	}
	return (
		<div className={`stage-drop${drop.over ? ' is-over' : ''}`} data-drop="lib" {...drop.props}>
			<Icon name="upload" />
			<h2>Drop images, clips or files here</h2>
			<p className="fine">{TAKES}, up to 40 MB and 50 megapixels. Files: PDF, Word, Excel, PowerPoint, CSV and Zip, up to 40 MB.</p>
			<div className="acts">
				<UploadButton className="btn" />
				<button type="button" className="btn ghost" onClick={onBack}>
					<Icon name="chev-l" size="sm" />
					Back to {back}
				</button>
			</div>
		</div>
	);
}
