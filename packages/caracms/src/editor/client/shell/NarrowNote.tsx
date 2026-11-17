/**
 * Below 1024 wide, the editor asks to be opened on a bigger screen (M2 Decision 8;
 * the mockup's #narrow). Shown by a container query (editor.css), so it's right at
 * first paint.
 */
import { useState } from 'react';
import { useEditor } from '../context.tsx';
import { BrandMark, useBrand } from './Brand.tsx';
import { Icon } from './Icons.tsx';

export function NarrowNote() {
	const editor = useEditor();
	const { host } = editor.site;
	const brand = useBrand();
	const address = `${host}/admin`;
	const [copied, setCopied] = useState(false);
	return (
		<div className="screen narrow" id="narrow" aria-label="Open the editor on a larger screen">
			<div className="nw">
				<div className="nw-in">
					<div className="nw-brand">
						<span className="si-logo">
							<BrandMark />
						</span>
						{brand.name}
					</div>
					<h1>Open the editor on a bigger screen</h1>
					<p>The editor needs a window at least 1,024 pixels wide.</p>
					<p>On a laptop or desktop, go to:</p>
					<div className="addr">
						<span>{address}</span>
						<button
							type="button"
							className="btn sm"
							onClick={() => {
								void navigator.clipboard?.writeText(`${location.protocol}//${address}`).then(() => setCopied(true));
							}}
						>
							<Icon name={copied ? 'check' : 'copy'} size="sm" />
							{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
