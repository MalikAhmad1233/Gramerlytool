/** Styles for the in-page UI. Lives inside a shadow root, isolated from the host page. */
export const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wm-root {
  --wm-bg: #ffffff; --wm-fg: #111827; --wm-muted: #6b7280; --wm-line: #e5e7eb; --wm-soft: #f5f5ff;
  --wm-brand: #4f46e5; --wm-brand-2: #7c3aed; --wm-ok: #059669;
  --wm-error: #e11d48; --wm-warning: #d97706; --wm-suggestion: #2563eb; --wm-ai: #7c3aed;
  --wm-shadow: 0 12px 32px rgba(17, 24, 39, .18), 0 2px 6px rgba(17, 24, 39, .08);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--wm-fg);
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
}
@media (prefers-color-scheme: dark) {
  .wm-root { --wm-bg: #1f2130; --wm-fg: #eef0ff; --wm-muted: #a1a5c0; --wm-line: #34374a; --wm-soft: #2a2d45;
    --wm-shadow: 0 12px 32px rgba(0,0,0,.5); }
}
.wm-underline { position: fixed; height: 3px; pointer-events: none; border-radius: 2px; opacity: .9;
  transition: height .08s ease, opacity .08s ease; }
.wm-underline.error { background: var(--wm-error); }
.wm-underline.warning { background: var(--wm-warning); }
.wm-underline.suggestion { background: var(--wm-suggestion); }
.wm-underline.ai { background: linear-gradient(90deg, var(--wm-brand), var(--wm-ai)); }
.wm-underline.hover, .wm-underline.active { height: 4px; opacity: 1; }
.wm-highlight { position: fixed; pointer-events: none; border-radius: 3px; background: rgba(79, 70, 229, .12); }

.wm-badge { position: fixed; pointer-events: auto; display: flex; align-items: center; gap: 4px;
  height: 26px; min-width: 26px; padding: 0 8px 0 4px; border-radius: 13px; border: 0; cursor: pointer;
  background: var(--wm-bg); color: var(--wm-fg); box-shadow: 0 2px 8px rgba(17,24,39,.2);
  font: 600 12px/1 system-ui, sans-serif; transition: transform .12s ease; }
.wm-badge:hover { transform: scale(1.06); }
.wm-badge .dot { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; color: #fff;
  background: linear-gradient(135deg, var(--wm-brand), var(--wm-brand-2)); font-size: 11px; }
.wm-badge.clean .dot { background: var(--wm-ok); }
.wm-badge.offline .dot { background: var(--wm-muted); }
.wm-badge.busy .dot { animation: wm-pulse 1s ease-in-out infinite; }
@keyframes wm-pulse { 50% { opacity: .55; } }

.wm-card { position: fixed; pointer-events: auto; width: 320px; max-width: calc(100vw - 16px);
  background: var(--wm-bg); border: 1px solid var(--wm-line); border-radius: 12px; box-shadow: var(--wm-shadow);
  padding: 12px 14px; animation: wm-in .12s ease-out; border-top: 3px solid var(--wm-suggestion); }
.wm-card.error { border-top-color: var(--wm-error); }
.wm-card.warning { border-top-color: var(--wm-warning); }
.wm-card.ai { border-top-color: var(--wm-ai); }
@keyframes wm-in { from { transform: translateY(4px); } }
.wm-card header, .wm-panel > header, .wm-item header { display: flex; align-items: center; gap: 8px; }
.wm-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; color: var(--wm-muted); }
.wm-chip i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.wm-chip i.error { background: var(--wm-error); } .wm-chip i.warning { background: var(--wm-warning); }
.wm-chip i.suggestion { background: var(--wm-suggestion); }
.wm-ai-tag { margin-left: auto; font-size: 10px; font-weight: 700; color: #fff; border-radius: 6px; padding: 2px 6px;
  background: linear-gradient(90deg, var(--wm-brand), var(--wm-ai)); }
.wm-title { font-weight: 650; font-size: 14px; margin: 6px 0 2px; }
.wm-message { color: var(--wm-muted); margin: 0 0 10px; }
.wm-diff { margin: 2px 0 6px; font-size: 14px; }
.wm-diff b { color: var(--wm-ok); }
.wm-diff del { color: var(--wm-error); text-decoration: line-through; opacity: .8; }
.wm-replacements { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.wm-btn { font: 600 13px/1 system-ui, sans-serif; border-radius: 8px; padding: 8px 12px; cursor: pointer;
  border: 1px solid var(--wm-line); background: var(--wm-bg); color: var(--wm-fg); }
.wm-btn:hover { background: var(--wm-soft); }
.wm-btn:focus-visible { outline: 2px solid var(--wm-brand); outline-offset: 1px; }
.wm-btn.primary { background: var(--wm-brand); border-color: var(--wm-brand); color: #fff; }
.wm-btn.primary:hover { filter: brightness(1.08); }
.wm-btn.ghost { border-color: transparent; color: var(--wm-muted); padding: 6px 8px; font-weight: 500; }
.wm-btn.ghost:hover { color: var(--wm-fg); }
.wm-btn[disabled] { opacity: .55; cursor: default; }
.wm-actions { display: flex; flex-wrap: wrap; gap: 2px; border-top: 1px solid var(--wm-line); padding-top: 6px; }
.wm-close { margin-left: auto; border: 0; background: transparent; color: var(--wm-muted); cursor: pointer;
  font-size: 18px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
.wm-close:hover { background: var(--wm-soft); color: var(--wm-fg); }

.wm-panel { position: fixed; pointer-events: auto; top: 12px; right: 12px; bottom: 12px; width: 360px;
  max-width: calc(100vw - 24px); display: flex; flex-direction: column; background: var(--wm-bg);
  border: 1px solid var(--wm-line); border-radius: 14px; box-shadow: var(--wm-shadow); animation: wm-in .14s ease-out; }
.wm-panel > header { padding: 14px 16px 10px; border-bottom: 1px solid var(--wm-line); }
.wm-brand { font-weight: 750; font-size: 15px; }
.wm-brand small { display: block; font-weight: 500; font-size: 11px; color: var(--wm-muted); }
.wm-score { margin-left: auto; text-align: right; }
.wm-score b { font-size: 20px; }
.wm-score span { display: block; font-size: 11px; color: var(--wm-muted); }
.wm-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.wm-tab { flex: 1; border: 0; background: transparent; padding: 8px; border-radius: 8px; cursor: pointer;
  font: 600 13px system-ui, sans-serif; color: var(--wm-muted); }
.wm-tab.active { background: var(--wm-soft); color: var(--wm-brand); }
.wm-body { overflow: auto; padding: 8px 12px 12px; flex: 1; }
.wm-empty { text-align: center; color: var(--wm-muted); padding: 32px 12px; }
.wm-empty b { display: block; color: var(--wm-fg); font-size: 15px; margin-bottom: 4px; }
.wm-item { border: 1px solid var(--wm-line); border-radius: 10px; padding: 10px 12px; margin-top: 8px; }
.wm-item:hover { border-color: var(--wm-brand); }
.wm-item .wm-title { font-size: 13px; margin: 4px 0; }
.wm-item .row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.wm-counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 2px; }
.wm-count { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: var(--wm-soft); color: var(--wm-muted); }
.wm-styles { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.wm-style { border: 1px solid var(--wm-line); background: var(--wm-bg); color: var(--wm-fg); border-radius: 999px;
  padding: 6px 12px; cursor: pointer; font: 500 12px system-ui, sans-serif; }
.wm-style.active { border-color: var(--wm-brand); background: var(--wm-brand); color: #fff; }
.wm-quote { border-left: 3px solid var(--wm-line); padding: 6px 10px; color: var(--wm-muted); margin: 6px 0 10px;
  white-space: pre-wrap; max-height: 120px; overflow: auto; }
.wm-alt { white-space: pre-wrap; font-size: 14px; }
.wm-note { font-size: 11px; color: var(--wm-muted); margin-top: 4px; }
.wm-footer { padding: 10px 14px; border-top: 1px solid var(--wm-line); font-size: 11px; color: var(--wm-muted);
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wm-footer > span { width: 100%; }
.wm-toast { position: fixed; pointer-events: auto; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: #111827; color: #fff; padding: 10px 14px; border-radius: 10px; box-shadow: var(--wm-shadow);
  max-width: min(480px, calc(100vw - 32px)); animation: wm-in .14s ease-out; }
.wm-spinner { width: 14px; height: 14px; border: 2px solid var(--wm-line); border-top-color: var(--wm-brand);
  border-radius: 50%; animation: wm-spin .8s linear infinite; display: inline-block; vertical-align: middle; }
@keyframes wm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wm-card, .wm-panel, .wm-toast { animation: none; } }
`;
