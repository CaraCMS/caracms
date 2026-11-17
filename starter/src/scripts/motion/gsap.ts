/**
 * GSAP with ScrollTrigger registered — the one place registration happens.
 * A module evaluates once per page, and Vite bundles it into one shared chunk however
 * many scripts import it, so every effect gets the same registered instance.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };
