/**
 * The overlays' CSS, injected into each preview iframe's <head> (never into the
 * public page; Decision 17). Lifted from the mockup's overlayCSS() (packages/caracms/test/mockups/
 * m2-editor.html), M2 → Rules → Overlays: a blue core with a white line both sides,
 * the same size on screen at any scale (`--k` = 1 / the frame's scale), hover thin
 * with a wash, selected 2px with a filled tag, a picked field ringed with its name,
 * teal for phone lines, amber dashes for too long and skipped, and the lock's veil,
 * a two-tone hatch that lifts (fades out over --dur-slow) when the lock goes.
 *
 * Colours come from the editor's tokens (`--ov*` in styles/tokens.css): the layer
 * copies them onto itself as `--cms-*` when it mounts (layer.ts), so there are no
 * raw colours here (M2 Decision 7). Everything is scoped under `#cms-overlays`, the
 * layer, so it can't touch the site; the rules outside it only set cursors, hide
 * the browser's own outline on the fields the layer rings, and give a mounted page
 * editor (on-page rich text) the one style ProseMirror needs, `white-space:
 * pre-wrap`, which applies only while it's mounted (Decision 3).
 *
 * A string, not a .css file: it goes into another document, so the editor's own
 * stylesheet pipeline doesn't apply.
 */
/** A size that stays the same on screen at any preview scale. */
const K = (n: number) => `calc(var(--k)*${n}px)`;

/**
 * The formatting bar of rich text typed on the page and what opens from it (on-page
 * rich text, Decision 9; rich-text-bar.ts), lifted from the mockup's RT CSS: the
 * sidebar toolbar's look at a constant size, the style menu, the link popover, and
 * the linked words' wash. A reset first, so a site's own rules for `button`, `input`
 * or `p` can't reach in.
 */
const RICH_TEXT_BAR_CSS = `#cms-overlays .cms-rt{position:absolute;left:0;top:0;width:100%;height:0;pointer-events:none;font:400 ${K(13)}/1.45 "caracms UI",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--cms-t);letter-spacing:0;text-transform:none;text-align:left;white-space:normal}
#cms-overlays .cms-rt :where(div,p,span,b,i,button,input){margin:0;padding:0;border:0;background:none;box-shadow:none;letter-spacing:0;text-transform:none;text-shadow:none;text-decoration:none;text-indent:0;float:none;min-width:0;min-height:0;max-width:none;font-style:normal;color:inherit}
#cms-overlays .cms-rt button{font-family:"caracms UI",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-appearance:none;appearance:none}
#cms-overlays .cms-rt :focus-visible{outline:${K(2)} solid var(--cms-focus);outline-offset:${K(1)}}
#cms-overlays .cms-rt .cms-i{width:${K(14)};height:${K(14)};flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
#cms-overlays .cms-hold{position:absolute;background:var(--cms-sel-halo);border-radius:${K(2)}}
#cms-overlays .cms-rtw{position:absolute;pointer-events:auto;transition:top var(--cms-dur-fast) cubic-bezier(.2,.8,.2,1),left var(--cms-dur-fast) cubic-bezier(.2,.8,.2,1);animation:cms-rise var(--cms-dur-base) cubic-bezier(.2,.8,.2,1)}
#cms-overlays .cms-rtw[data-place=below]{animation-name:cms-drop}
@keyframes cms-rise{from{opacity:0;translate:0 ${K(6)}}}
@keyframes cms-drop{from{opacity:0;translate:0 ${K(-6)}}}
#cms-overlays .cms-rtbar,#cms-overlays .cms-rtmenu,#cms-overlays .cms-lpop{background:var(--cms-surface);box-shadow:0 ${K(14)} ${K(36)} var(--cms-pop),0 0 0 ${K(1)} var(--cms-pop-line)}
#cms-overlays .cms-rtbar{display:flex;align-items:center;gap:${K(2)};padding:${K(3)};border-radius:${K(8)};white-space:nowrap}
#cms-overlays .cms-rtbar button{display:inline-grid;place-items:center;width:${K(28)};height:${K(26)};padding:0;border:0;border-radius:${K(5)};background:none;color:var(--cms-muted);font-size:${K(13)};font-weight:600;line-height:1;cursor:pointer;transition:background var(--cms-dur-fast),color var(--cms-dur-fast)}
#cms-overlays .cms-rtbar button:hover{background:var(--cms-hover);color:var(--cms-t)}
#cms-overlays .cms-rtbar button[aria-pressed=true],#cms-overlays .cms-rtbar button[aria-expanded=true]{background:var(--cms-pressed);color:var(--cms-t)}
#cms-overlays .cms-rtbar button b{font-weight:700}
#cms-overlays .cms-rtbar button i{font:italic 600 ${K(14)}/1 Georgia,serif}
#cms-overlays .cms-rtbar .cms-st{display:inline-flex;align-items:center;justify-content:space-between;gap:${K(4)};width:auto;min-width:${K(100)};padding:0 ${K(6)} 0 ${K(8)};color:var(--cms-t);font-weight:500}
#cms-overlays .cms-rtbar .cms-st .cms-i{width:${K(12)};height:${K(12)};color:var(--cms-icon)}
#cms-overlays .cms-rtsep{flex:none;width:${K(1)};height:${K(16)};margin:0 ${K(3)};background:var(--cms-line)}
#cms-overlays .cms-rtmenu{position:absolute;left:0;top:100%;min-width:${K(188)};padding:${K(4)};border-radius:${K(10)}}
#cms-overlays .cms-rtmenu button{display:flex;align-items:center;gap:${K(8)};width:100%;height:${K(30)};padding:0 ${K(8)};border:0;border-radius:${K(5)};background:none;color:var(--cms-t);font-size:${K(13)};line-height:1;text-align:left;cursor:pointer}
#cms-overlays .cms-rtmenu button:hover{background:var(--cms-hover)}
#cms-overlays .cms-rtmenu button[aria-checked=true]{background:var(--cms-sel-wash);color:var(--cms-sel-strong)}
#cms-overlays .cms-rtmenu .k{margin-left:auto;display:inline-flex}
#cms-overlays .cms-rtmenu .st-h2{font-size:${K(16)};font-weight:600;letter-spacing:-.01em}
#cms-overlays .cms-rtmenu .st-h3{font-size:${K(14)};font-weight:600}
#cms-overlays .cms-lpop{position:absolute;left:0;top:100%;padding:${K(4)};border-radius:${K(10)}}
#cms-overlays .cms-lpop .find{position:relative;margin:0 0 ${K(4)}}
#cms-overlays .cms-lpop .find .cms-i{position:absolute;left:${K(10)};top:50%;translate:0 -50%;width:${K(16)};height:${K(16)};color:var(--cms-icon)}
#cms-overlays .cms-lpop input{box-sizing:border-box;width:100%;height:${K(32)};padding:0 ${K(10)} 0 ${K(34)};border:${K(1)} solid var(--cms-line-strong);border-radius:${K(7)};background:var(--cms-surface);color:var(--cms-t);font:400 ${K(13)}/1 "caracms UI",system-ui,sans-serif;outline:0;-webkit-appearance:none;appearance:none}
#cms-overlays .cms-lpop input:focus{border-color:var(--cms-sel);box-shadow:0 0 0 ${K(3)} var(--cms-sel-halo)}
#cms-overlays .cms-lpop input[aria-invalid=true]{border-color:var(--cms-wdot)}
#cms-overlays .cms-msg{display:flex;align-items:flex-start;gap:${K(6)};margin:${K(2)} ${K(6)} ${K(6)};font-size:${K(12)};font-weight:500;line-height:1.4;color:var(--cms-wtext)}
#cms-overlays .cms-msg .cms-i{margin-top:${K(1)};color:var(--cms-wdot)}
#cms-overlays .cms-lpop .sw-h{padding:${K(6)} ${K(8)} ${K(4)};font-size:${K(11)};font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--cms-muted)}
#cms-overlays .cms-lpop .drow{display:flex;align-items:center;gap:${K(8)};width:100%;min-height:${K(32)};padding:0 ${K(8)};border:0;border-radius:${K(7)};background:none;color:var(--cms-t);font-size:${K(13)};line-height:1.3;text-align:left;cursor:pointer}
#cms-overlays .cms-lpop .drow:hover,#cms-overlays .cms-lpop .drow.is-active{background:var(--cms-hover)}
#cms-overlays .cms-lpop .drow .cms-i{width:${K(16)};height:${K(16)};color:var(--cms-icon)}
#cms-overlays .cms-lpop .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cms-overlays .cms-lpop .crumb{color:var(--cms-subtle);font-weight:500}
#cms-overlays .cms-lpop .meta{flex:none;color:var(--cms-subtle)}
#cms-overlays .cms-lpop .mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:${K(10.5)}}
#cms-overlays .cms-lpop .sw-more{padding:${K(6)} ${K(8)};font-size:${K(12)};color:var(--cms-subtle)}
#cms-overlays .cms-lpop-foot{margin-top:${K(4)};padding:${K(8)} ${K(8)} ${K(4)};border-top:${K(1)} solid var(--cms-line);font-size:${K(11)};line-height:1.5;color:var(--cms-subtle)}
#cms-overlays .cms-lpop .cms-top{display:flex;gap:${K(4)};margin:0 0 ${K(4)}}
#cms-overlays .cms-lpop .cms-top .find{flex:1;min-width:0;margin:0}
#cms-overlays .cms-lpop .cms-btn{display:inline-flex;align-items:center;gap:${K(6)};flex:none;height:${K(32)};padding:0 ${K(10)};border:${K(1)} solid var(--cms-line-strong);border-radius:${K(7)};background:var(--cms-surface);color:var(--cms-t);font-size:${K(13)};font-weight:500;cursor:pointer}
#cms-overlays .cms-lpop .cms-btn:hover{background:var(--cms-hover)}
#cms-overlays .cms-lpop .cms-btn .cms-i{color:var(--cms-icon)}
#cms-overlays .cms-ftype{position:relative;display:block;width:${K(18)};height:${K(22)};flex:none;border:${K(1)} solid var(--cms-line-strong);border-radius:${K(2)};background:linear-gradient(var(--cms-line-strong),var(--cms-line-strong)) ${K(4)} ${K(8)}/calc(100% - ${K(8)}) ${K(1)} no-repeat,linear-gradient(var(--cms-line-strong),var(--cms-line-strong)) ${K(4)} ${K(11)}/calc(100% - ${K(8)}) ${K(1)} no-repeat,var(--cms-surface);clip-path:polygon(0 0,calc(100% - ${K(6)}) 0,100% ${K(6)},100% 100%,0 100%)}
#cms-overlays .cms-picked{display:flex;align-items:center;gap:${K(8)};padding:${K(6)} ${K(4)} ${K(6)} ${K(8)};border-radius:${K(7)};background:var(--cms-wash)}
#cms-overlays .cms-picked .ft{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.35}
#cms-overlays .cms-picked b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cms-overlays .cms-picked small{font-size:${K(11.5)};color:var(--cms-subtle)}
#cms-overlays .cms-picked>.cms-i{color:var(--cms-wdot)}
#cms-overlays .cms-ib{display:grid;place-items:center;width:${K(26)};height:${K(26)};flex:none;border-radius:${K(6)};color:var(--cms-icon);cursor:pointer}
#cms-overlays .cms-ib:hover{background:var(--cms-hover);color:var(--cms-t)}
#cms-overlays .cms-opens{display:flex;align-items:center;gap:${K(8)};margin-top:${K(6)};padding:0 ${K(4)}}
#cms-overlays .cms-opens .lbl{flex:none;font-size:${K(11.5)};font-weight:600;color:var(--cms-muted)}
#cms-overlays .cms-seg{display:flex;flex:1;padding:${K(2)};border-radius:${K(7)};background:var(--cms-pressed)}
#cms-overlays .cms-seg button{display:inline-flex;flex:1;align-items:center;justify-content:center;gap:${K(5)};height:${K(26)};border-radius:${K(5)};color:var(--cms-muted);font-size:${K(12.5)};font-weight:500;cursor:pointer}
#cms-overlays .cms-seg button[aria-checked=true]{background:var(--cms-surface);color:var(--cms-t);box-shadow:0 ${K(1)} ${K(2)} var(--cms-pop)}
#cms-overlays .cms-seg .cms-i{width:${K(13)};height:${K(13)}}
@media (prefers-reduced-motion:reduce){#cms-overlays .cms-rtw,#cms-overlays .cms-rtbar button{transition:none;animation:none}}
`;

export const OVERLAY_CSS = `
html [data-cms-block]{cursor:default}
html [data-cms-kind="text"]{cursor:text}
html [data-cms-kind="lockup"]{cursor:pointer}
html [data-cms-kind="text"]:focus{outline:none}
html [data-cms-kind="richText"][tabindex]{cursor:text}
html [data-cms-kind="richText"][tabindex]:focus{outline:none}
html [data-cms-kind="richText"].ProseMirror{white-space:pre-wrap}
#cms-overlays{all:initial;position:absolute;left:0;top:0;width:100%;height:0;overflow:visible;pointer-events:none;z-index:2147483000;font-family:"caracms UI",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;line-height:1;letter-spacing:0;text-transform:none}
#cms-overlays *{box-sizing:border-box}
#cms-overlays .cms-box{position:absolute;border-radius:calc(var(--k)*3px)}
#cms-overlays .cms-hov{border:calc(var(--k)*1.5px) solid var(--cms-ov);background:var(--cms-wash);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo),inset 0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-sel{border:calc(var(--k)*2px) solid var(--cms-ov);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo),inset 0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-fhov{border:calc(var(--k)*1px) dashed var(--cms-ov);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-pick{border:calc(var(--k)*2px) solid var(--cms-ov);border-radius:calc(var(--k)*4px);box-shadow:0 0 0 calc(var(--k)*1.5px) var(--cms-halo),inset 0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .phone{--cms-ov:var(--cms-phone)}
#cms-overlays .cms-type{border:calc(var(--k)*1.5px) solid var(--cms-ov);border-radius:calc(var(--k)*4px);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo),0 0 0 calc(var(--k)*5px) var(--cms-ring)}
#cms-overlays .cms-warn{border:calc(var(--k)*2px) dashed var(--cms-warn);border-radius:calc(var(--k)*4px);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo),inset 0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-tag,#cms-overlays .cms-chip{position:absolute;display:inline-flex;align-items:center;gap:calc(var(--k)*5px);height:calc(var(--k)*22px);padding:0 calc(var(--k)*8px);background:var(--cms-ov);color:var(--cms-on);font-size:calc(var(--k)*11.5px);font-weight:600;line-height:1;white-space:nowrap;box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-tag{left:calc(var(--k)*-2px);top:calc(var(--k)*-2px);border-radius:calc(var(--k)*3px) 0 calc(var(--k)*6px) 0}
#cms-overlays .cms-hov .cms-tag{background:var(--cms-surface);color:var(--cms-ov-text);left:calc(var(--k)*-1.5px);top:calc(var(--k)*-1.5px);box-shadow:inset 0 0 0 calc(var(--k)*1.5px) var(--cms-ov)}
#cms-overlays .cms-chip{left:calc(var(--k)*-2px);bottom:100%;margin-bottom:calc(var(--k)*5px);border-radius:calc(var(--k)*5px)}
#cms-overlays .cms-chip.in{bottom:auto;top:calc(var(--k)*4px);left:calc(var(--k)*4px);margin:0}
#cms-overlays .cms-chip.warn{background:var(--cms-warn-wash);color:var(--cms-warn-text);box-shadow:inset 0 0 0 calc(var(--k)*1.5px) var(--cms-warn),0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-go{pointer-events:auto;position:absolute;display:inline-flex;align-items:center;height:calc(var(--k)*22px);padding:0 calc(var(--k)*9px);border:0;border-radius:999px;background:var(--cms-surface);color:var(--cms-ov-text);font:600 calc(var(--k)*11.5px)/1 "caracms UI",system-ui,sans-serif;box-shadow:0 0 0 calc(var(--k)*1.5px) var(--cms-ov),0 calc(var(--k)*3px) calc(var(--k)*10px) var(--cms-lift);cursor:pointer;white-space:nowrap}
#cms-overlays .cms-go.off{pointer-events:none;cursor:default;box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo),0 calc(var(--k)*3px) calc(var(--k)*10px) var(--cms-lift)}
#cms-overlays .cms-go:focus-visible{outline:calc(var(--k)*2px) solid var(--cms-ov);outline-offset:calc(var(--k)*2px)}
#cms-overlays .cms-add{pointer-events:auto;position:absolute;left:50%;top:0;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:calc(var(--k)*4px);height:calc(var(--k)*24px);padding:0 calc(var(--k)*11px);border:0;border-radius:999px;background:var(--cms-surface);color:var(--cms-ov-text);font:600 calc(var(--k)*11.5px)/1 "caracms UI",system-ui,sans-serif;box-shadow:0 0 0 calc(var(--k)*1.5px) var(--cms-ov),0 calc(var(--k)*3px) calc(var(--k)*10px) var(--cms-lift);cursor:pointer;white-space:nowrap}
#cms-overlays .cms-add:hover{background:var(--cms-ov);color:var(--cms-on)}
#cms-overlays .cms-add:focus-visible,#cms-overlays .cms-skip button:focus-visible{outline:calc(var(--k)*2px) solid var(--cms-ov);outline-offset:calc(var(--k)*2px)}
#cms-overlays .cms-empty{position:absolute;border:calc(var(--k)*1.5px) dashed var(--cms-ov);border-radius:calc(var(--k)*6px);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo),inset 0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-empty .cms-add{top:50%;height:calc(var(--k)*34px);font-size:calc(var(--k)*13px);padding:0 calc(var(--k)*16px)}
#cms-overlays .cms-skip{position:absolute;left:0;right:0;height:0}
#cms-overlays .cms-skip::before{content:"";position:absolute;left:0;right:0;top:calc(var(--k)*-1px);border-top:calc(var(--k)*2px) dashed var(--cms-warn);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-skip button{pointer-events:auto;cursor:pointer;position:absolute;left:50%;top:0;transform:translate(-50%,-50%);height:calc(var(--k)*22px);padding:0 calc(var(--k)*9px);display:inline-flex;align-items:center;border:0;border-radius:999px;background:var(--cms-warn-wash);color:var(--cms-warn-text);font:600 calc(var(--k)*11.5px)/1 "caracms UI",system-ui,sans-serif;white-space:nowrap;box-shadow:inset 0 0 0 calc(var(--k)*1.5px) var(--cms-warn),0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-skip.on button{box-shadow:inset 0 0 0 calc(var(--k)*2px) var(--cms-warn),0 0 0 calc(var(--k)*1px) var(--cms-halo),0 0 0 calc(var(--k)*4px) var(--cms-ring)}
/* Edit in context (its mockup): the chip on a field from another document names that document first, quieter;
   the element an opened document came from keeps a faint ring; held by someone else, rings and chips go the lock's grey. */
#cms-overlays .cms-chip .src{font-weight:500;opacity:.82}
#cms-overlays .cms-chip .cms-i{width:calc(var(--k)*12px);height:calc(var(--k)*12px);fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
#cms-overlays .cms-fhov .cms-chip{background:var(--cms-surface);color:var(--cms-ov-text);box-shadow:inset 0 0 0 calc(var(--k)*1.5px) var(--cms-ov),0 0 0 calc(var(--k)*1px) var(--cms-halo)}
#cms-overlays .cms-open{border:calc(var(--k)*1.5px) solid color-mix(in srgb,var(--cms-ov) 42%,transparent);border-radius:calc(var(--k)*4px);box-shadow:0 0 0 calc(var(--k)*1px) var(--cms-halo)}
/* Review gaps (Decision 7): the state switch beside a selected block's tag, one size on screen at every width. */
#cms-overlays .cms-stbox{pointer-events:none}
#cms-overlays .cms-tagrow{position:absolute;left:calc(var(--k)*-2px);top:calc(var(--k)*-2px);display:flex;align-items:center;gap:calc(var(--k)*6px);pointer-events:none}
#cms-overlays .cms-tagrow .cms-tag{position:static}
#cms-overlays .cms-stbox.cms-open .cms-tagrow{left:calc(var(--k)*-1.5px);top:calc(var(--k)*-1.5px)}
#cms-overlays .cms-tag.quiet{background:var(--cms-surface);color:var(--cms-ov-text);box-shadow:0 0 0 calc(var(--k)*1.5px) color-mix(in srgb,var(--cms-ov) 42%,transparent)}
#cms-overlays .cms-states{pointer-events:auto;position:relative;display:inline-flex;align-items:center;gap:calc(var(--k)*2px);height:calc(var(--k)*24px);padding:calc(var(--k)*2px);border-radius:calc(var(--k)*6px);background:var(--cms-surface);box-shadow:0 0 0 calc(var(--k)*1.5px) var(--cms-ov),0 calc(var(--k)*3px) calc(var(--k)*10px) var(--cms-lift);font:600 calc(var(--k)*11.5px)/1 "caracms UI",system-ui,sans-serif;white-space:nowrap}
#cms-overlays .cms-states button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:calc(var(--k)*4px);height:100%;padding:0 calc(var(--k)*8px);border:0;border-radius:calc(var(--k)*4px);background:none;color:var(--cms-ov-text);font:inherit;cursor:pointer}
#cms-overlays .cms-states button:hover{background:var(--cms-wash)}
#cms-overlays .cms-states button[aria-checked="true"]{background:var(--cms-ov);color:var(--cms-on)}
#cms-overlays .cms-states button:focus-visible{outline:calc(var(--k)*2px) solid var(--cms-ov);outline-offset:calc(var(--k)*1px)}
#cms-overlays .cms-states .cms-i{width:calc(var(--k)*12px);height:calc(var(--k)*12px);fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
#cms-overlays .cms-states.compact{display:none}
#cms-overlays .fold .cms-states:not(.compact){display:none}
#cms-overlays .fold .cms-states.compact{display:inline-flex}
#cms-overlays .cms-states.compact button.cur{background:none;color:var(--cms-ov-text)}
#cms-overlays .cms-smenu{position:absolute;left:0;top:calc(100% + var(--k)*6px);display:flex;flex-direction:column;min-width:calc(var(--k)*150px);padding:calc(var(--k)*4px);border-radius:calc(var(--k)*7px);background:var(--cms-surface);box-shadow:0 0 0 calc(var(--k)*1.5px) var(--cms-ov),0 calc(var(--k)*6px) calc(var(--k)*18px) var(--cms-lift)}
#cms-overlays .cms-smenu button{justify-content:flex-start;height:calc(var(--k)*26px)}
#cms-overlays .cms-wait{display:inline-block;width:calc(var(--k)*6px);height:calc(var(--k)*6px);border-radius:50%;background:currentColor;animation:cms-pulse 900ms ease-in-out infinite alternate}
@keyframes cms-pulse{from{opacity:.25}to{opacity:1}}
@media (prefers-reduced-motion:reduce){#cms-overlays .cms-wait{animation:none}}
#cms-overlays .ro{--cms-ov:var(--cms-locked)}
#cms-overlays .cms-veil{position:absolute;left:0;top:0;width:100%;pointer-events:auto;cursor:not-allowed;background:repeating-linear-gradient(135deg,var(--cms-veil-a) 0 calc(var(--k)*7px),var(--cms-veil-b) calc(var(--k)*7px) calc(var(--k)*14px));transition:opacity var(--cms-dur,0ms) ease}
#cms-overlays .cms-veil.out{opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){#cms-overlays .cms-veil{transition:none}}
${RICH_TEXT_BAR_CSS}`;

/** The editor's overlay tokens, copied onto the layer as `--cms-*` (overlay-css.ts uses only these). */
export const OVERLAY_TOKENS: Record<string, string> = {
	'--cms-ov': '--ov',
	'--cms-ov-text': '--ov-text',
	'--cms-halo': '--ov-halo',
	'--cms-on': '--ov-on',
	'--cms-surface': '--ov-surface',
	'--cms-wash': '--ov-wash',
	'--cms-phone': '--ov-phone',
	'--cms-warn': '--ov-warn',
	'--cms-warn-text': '--ov-warn-text',
	'--cms-warn-wash': '--ov-warn-wash',
	'--cms-ring': '--ov-ring',
	'--cms-lift': '--ov-lift',
	'--cms-veil-a': '--ov-veil-a',
	// Edit in context, Decision 14: a ring and chip on a field someone else is editing.
	'--cms-locked': '--status-locked',
	'--cms-veil-b': '--ov-veil-b',
	// The veil lifts over --dur-slow (M2 → Motion); 0ms under reduced motion, as the token is.
	'--cms-dur': '--dur-slow',
	// The formatting bar of rich text on the page (RICH_TEXT_BAR_CSS): the chrome's own tokens, as the sidebar's toolbar has them.
	'--cms-t': '--text',
	'--cms-muted': '--text-muted',
	'--cms-subtle': '--text-subtle',
	'--cms-icon': '--icon',
	'--cms-hover': '--surface-hover',
	'--cms-pressed': '--surface-pressed',
	'--cms-line': '--border',
	'--cms-line-strong': '--border-strong',
	'--cms-sel': '--select',
	'--cms-sel-strong': '--select-strong',
	'--cms-sel-wash': '--select-wash',
	'--cms-sel-halo': '--select-halo',
	'--cms-focus': '--focus',
	'--cms-wtext': '--status-warning',
	'--cms-wdot': '--status-warning-dot',
	'--cms-pop': '--ov-pop',
	'--cms-pop-line': '--ov-pop-line',
	'--cms-dur-fast': '--dur-fast',
	'--cms-dur-base': '--dur-base',
};
