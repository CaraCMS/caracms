/**
 * The player's one behaviour (M5b Decision 4; the template's `videoPlayer.ts`): on the
 * first click, import `@mux/mux-player` (its own chunk, which nothing loads before),
 * mount `<mux-player playback-id autoplay>` in the same frame with sound, and move
 * focus to it. Browser only; imported only by MediaPlayer.astro's script, so a page
 * without a player never loads it.
 */
export function initPlayers(): void {
	for (const host of document.querySelectorAll<HTMLElement>('[data-caracms-player]')) {
		if (host.dataset.caracmsReady) continue;
		host.dataset.caracmsReady = '';
		const button = host.querySelector<HTMLButtonElement>('[data-caracms-play]');
		const { playbackId, name = '', poster = '' } = host.dataset;
		if (!button || !playbackId) continue;
		let busy = false;
		button.addEventListener('click', async () => {
			if (busy) return;
			busy = true;
			button.setAttribute('aria-busy', 'true');
			try {
				await import('@mux/mux-player');
			} catch {
				// The chunk didn't arrive (offline, blocked): the clip's MP4 is the fallback.
				busy = false;
				button.removeAttribute('aria-busy');
				window.location.assign(`https://stream.mux.com/${encodeURIComponent(playbackId)}/highest.mp4`);
				return;
			}
			const player = document.createElement('mux-player');
			player.setAttribute('playback-id', playbackId);
			player.setAttribute('stream-type', 'on-demand');
			if (poster) player.setAttribute('poster', poster);
			if (name) {
				player.setAttribute('metadata-video-title', name);
				player.setAttribute('aria-label', name);
			}
			player.setAttribute('playsinline', '');
			player.setAttribute('autoplay', '');
			host.classList.add('is-playing');
			button.removeAttribute('aria-busy');
			host.append(player);
			if (!player.hasAttribute('tabindex')) player.tabIndex = -1;
			player.focus({ preventScroll: true });
		});
	}
}
