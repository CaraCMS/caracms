/** A menu drawn in React from a slot block's fields (a ported site's header, smaller). */
export default function Nav({ links, menuLabel }: { links: { label: string; href: string }[]; menuLabel: string }) {
	return (
		<nav>
			{links.map((l) => (
				<a key={l.href} href={l.href}>
					<span>{l.label}</span>
				</a>
			))}
			<button type="button">{menuLabel}</button>
		</nav>
	);
}
