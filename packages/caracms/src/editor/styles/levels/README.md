Each pane level's own CSS, beyond the mockup's (which is all in `../editor.css`
already): `block.css`, `documents.css`, `document.css`, `collection.css`. The admin
route loads every `.css` file here, so a phase adds its file without touching a
shared one. Tokens only, no raw colours (M2 Decision 7).
