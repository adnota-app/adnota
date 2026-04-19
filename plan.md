1. **HUD Colors**:
- Create classes in `vellumUI.css` for tool HUD colors: `-red` (Eraser), `-orange` (Sticky), `-purple` (Drawing, default). 
- Ensure Resizer uses `-blue` (already defined in `resizer.css`).
- Modify `eraser.js`, `sticky.js` to apply these classes to their logos, dividers, and hover states. Need to inject CSS for the tooltip hover states. Just define global modifiers in `vellumUI.css`:
```css
.vellum-toolbar-logo-red { background: rgba(239, 68, 68, 0.35); color: #fca5a5; }
.vellum-toolbar-divider-red { background: rgba(239, 68, 68, 0.25); }
#vellum-eraser-hud .vellum-undo-btn:hover, #vellum-eraser-hud .vellum-tool-btn:hover { background: rgba(239, 68, 68, 0.15); }
#vellum-eraser-hud .vellum-undo-btn:hover svg, #vellum-eraser-hud .vellum-tool-btn:hover svg { stroke: #fca5a5; }

/* Sticky (Orange/Yellow) */
.vellum-toolbar-logo-orange { background: rgba(245, 158, 11, 0.35); color: #fcd34d; }
.vellum-toolbar-divider-orange { background: rgba(245, 158, 11, 0.25); }
#vellum-sticky-toolbar .vellum-undo-btn:hover { background: rgba(245, 158, 11, 0.15); }
#vellum-sticky-toolbar .vellum-undo-btn:hover svg { stroke: #fcd34d; }
```

2. **Drag handle size**:
- Check `vellum-toolbar-drag` class. It's in `highlighter.css`. Move it to `vellumUI.css` maybe, or just modify everywhere. Actually, `highlighter.css` might be the only place where `.vellum-toolbar-drag` is styled? Let's check `grep vellum-toolbar-drag`. 
- `highlighter.css` has `.vellum-toolbar-drag`.
- I will change `font-size: 10px` to `font-size: 18px`, `margin-right: 8px`.

3. **Header Dark Mode**:
- `popup/style.css` `.header { background: linear-gradient(135deg, #151515 0%, #2a1458 100%); }`
- `pages/sites.css` `--header-dark: linear-gradient(135deg, #151515 0%, #2a1458 100%);`

4. **Tooltips**:
- `[data-tooltip]` logic in `vellumUI.css`.
- Update all `btn.title =` and `btn.setAttribute('title', ...)` in `highlighter.js`, `marker.js`, `resizer.js`, `eraser.js`, `sticky.js`, `vellumUI.js`.

5. **Trash icon vertical lines**:
- `lib/vellumUI.js`. Update `M8 9v6` and `M12 9v6` to `M9 9v6` and `M11 9v6`.

