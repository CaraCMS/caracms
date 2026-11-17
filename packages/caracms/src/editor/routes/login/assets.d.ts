// Vite's asset imports the sign-in route uses (Vite's own client types aren't in the
// package's tsconfig): a font's URL in the bundle, and a stylesheet's text.
declare module '*.woff2?url' {
	const url: string;
	export default url;
}
declare module '*.css?raw' {
	const css: string;
	export default css;
}
