/**
 * The companion pattern, on top of `hostEffect()`.
 *
 * A companion renders a hidden marker inside the markup it animates, and the
 * marker's parent is the HOST. The component that renders the companion
 * decides the host just by where it puts it (a section, a tile root, a
 * parallax frame), with no hook of its own on the host.
 *
 * Each `.astro` companion (the starter ships none: no effects, M7 Decision 20) renders
 * `<span hidden data-effect="<name>"></span>` plus a `<script>` that calls
 * this. `hostEffect()` finds every marker and sets each one up exactly once;
 * the setup gets the marker's parent.
 *
 *   markerEffect('drift', (section) => { … })();
 */
import { hostEffect } from './hosts.ts';

export function markerEffect(name: string, setup: (host: HTMLElement) => void): () => void {
  return hostEffect<HTMLElement>(`span[hidden][data-effect="${name}"]`, (marker) => {
    const host = marker.parentElement;
    if (host) setup(host);
  });
}
