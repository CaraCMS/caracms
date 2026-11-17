/**
 * The zone as people say it: "Ireland Time", "New Zealand Time"; UTC as "UTC".
 *
 * The name comes from the runtime's ICU data, and two runtimes can word one zone
 * differently (one says "Ireland Time" where another says "Irish Time", by ICU version). So the server
 * works it out once and sends it with the site (`EditorSite.timeZoneName`,
 * admin-props.ts), and the browser shows that one (`editor.timeZoneName()`) rather than
 * asking its own ICU: a page rendered on the server and hydrated in the browser must
 * read the same.
 */
export function zoneName(timeZone: string): string {
	let zone = timeZone;
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone });
	} catch {
		zone = 'UTC';
	}
	if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
	try {
		const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
		if (name && !/^GMT[+-]/.test(name)) return name;
	} catch {
		/* below */
	}
	return zone;
}
