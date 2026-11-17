/**
 * The brand's logo slot (M2 → Brand slots), wherever the chrome shows the site's
 * mark: the bar, the documents level's header and the narrow note.
 *
 * A site's logo (Site Settings' `brand.logo`, a signed URL from the server: M5b
 * Decision 11) fills the slot. A site with
 * no logo gets its initial on its accent: the accent fills the slot's tile, the
 * letter is light or dark by contrast and a pale accent gets a darker edge (M2
 * Decision 5; brand.ts computes both), so any accent stays legible.
 *
 * All four slots are Site Settings' (M5a Decision 10): `editor.brand`, which the
 * live poll keeps current, so a change shows without a reload. `useBrand()` is the
 * chrome's one way to read them.
 */
import { useEditor, useStore } from '../context.tsx';
import type { EditorBrand } from '../../types.ts';

/** The brand as it applies now (Site Settings' name, accent, logo and icon). */
export function useBrand(): EditorBrand {
	const editor = useEditor();
	return useStore(editor.brand);
}

export function BrandMark() {
	const brand = useBrand();
	if (brand.logo) return <img src={brand.logo} alt="" />;
	const initial = [...brand.name.trim()][0]?.toLocaleUpperCase() ?? '';
	return (
		<span className="logo-mono" aria-hidden="true">
			{initial}
		</span>
	);
}
