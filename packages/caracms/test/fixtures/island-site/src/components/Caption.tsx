/** A body block's island: the caption carries the marker the block hands it; the credit doesn't; one line is its own. */
export default function Caption({ caption, credit, mark }: { caption: string; credit: string; mark: Record<string, string> }) {
	return (
		<figure>
			<figcaption {...mark}>{caption}</figcaption>
			<p className="credit">{credit}</p>
			<p>Drawn in React</p>
		</figure>
	);
}
