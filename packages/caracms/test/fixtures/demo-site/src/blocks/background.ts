import { select } from 'caracms/config';

/**
 * Every demo block's background: Light, Dark, or Photo (one fixed image shipped
 * with the demo, public/backgrounds/hills.svg; media fields are M5's).
 */
export const background = () =>
	select({
		label: 'Background',
		options: [
			{ value: 'light', label: 'Light' },
			{ value: 'dark', label: 'Dark' },
			{ value: 'photo', label: 'Photo' },
		],
	});
