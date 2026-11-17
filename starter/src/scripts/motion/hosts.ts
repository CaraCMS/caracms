/**
 * Per-instance scoping: each instance of an effect wires only its own subtree.
 *
 * An Astro component's `<script>` is bundled once and runs once per page,
 * however many instances rendered. So the script finds its hosts by selector,
 * and this helper makes sure each host is set up exactly
 * once, even if the returned function is called again.
 *
 *   const run = hostEffect('header[data-nav-animated]', (header) => { … });
 *   run();
 *
 * Each effect gets its own WeakSet, so two different effects can share one host
 * element without blocking each other. Nothing is torn down: pages are full
 * loads (no ClientRouter), so the document itself is the lifetime.
 */
export function hostEffect<T extends HTMLElement = HTMLElement>(
  selector: string,
  setup: (host: T) => void,
): () => void {
  const initialised = new WeakSet<T>();
  return () => {
    document.querySelectorAll<T>(selector).forEach((host) => {
      if (initialised.has(host)) return;
      initialised.add(host);
      setup(host);
    });
  };
}
