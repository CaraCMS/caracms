/**
 * Popovers that open upward from the bar. Phase 2's: preview trouble (M2: "a render
 * that failed keeps the last good preview and says the latest change couldn't be
 * shown"). The switcher is Phase 4's (pane/switcher.tsx).
 */
import { useEditor, useStore } from '../context.tsx';
import { Switcher } from '../pane/switcher.tsx';
import { HistoryPop, WaitingPop } from '../live/publish.tsx';
import { AccountPop } from '../live/session.tsx';

export function Popovers() {
	const editor = useEditor();
	const pop = useStore(editor.view, (v) => v.pop);
	const failed = useStore(editor.previewStatus, (s) => s.failed);
	return (
		<div id="pops">
			{pop === 'switcher' ? <Switcher /> : null}
			{/* Live mode (M4): Publish's summary, its history, the account. */}
			{editor.mode === 'live' && pop === 'waiting' ? <WaitingPop /> : null}
			{editor.mode === 'live' && pop === 'history' ? <HistoryPop /> : null}
			{editor.mode === 'live' && pop === 'account' ? <AccountPop /> : null}
			{pop === 'preview-trouble' && failed ? (
				<div className="pop" role="dialog" aria-label="Preview not updated" style={{ left: 'calc(var(--side-col) + 12px)', width: 360 }}>
					<div className="pop-h">
						<div>
							<h2>The latest change couldn't be shown</h2>
							<p className="sub">Your change is kept.</p>
						</div>
					</div>
					<div className="pop-f">
						<span className="sp" />
						<button
							type="button"
							className="btn ink"
							onClick={() => {
								editor.setPop(null);
								editor.preview?.retry();
							}}
						>
							Try again
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
