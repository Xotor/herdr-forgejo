import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, checking, exec, focused, layout, panes, props, readTextFile, run, spaces, theme, window } from "herdr";

// Repository-global memory cache, shared by mod copies and worktrees; no credentials.
const cache = new Map();
function find(node, id) { if (node?.id === id) return node; for (const n of node?.children ?? []) { const r = find(n, id); if (r) return r; } }
function location() {
  const s = spaces().find(s => s.active), f = focused();
  const p = panes().find(p => p.pane === f?.pane);
  const on = f?.pane === null && f?.terminal ? (f.terminal.includes('/') ? f.terminal.split('/')[0] : null) : s?.machine ?? null;
  return { cwd: p?.cwd || f?.cwd || s?.folder, on };
}
function labelColor(label, t) {
  const name = label.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  return name === 'ready' ? t.ansi2 : name === 'in progress' ? t.ansi4 : name === 'refinement' ? t.ansi1 : t.muted;
}
export default class Issues extends View {
  init(_p, cx) {
    this.state = "open"; this.tags = new Map();
    this.search = InputState.new({ placeholder: "Search issues..." });
    this.search.on("change", (_e, cx) => cx.notify());
    this.error = null;
    if (checking() || props()?.button) return;
    this.refresh(cx);
    cx.timer.every(30000, cx => { if (this.visible()) this.refresh(cx, true); });
  }
  visible() { const root = layout(); return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "forgejo-issues"; }
  refresh(cx, force = false) {
    if (checking() || props()?.button) return;
    const loc = location(), next = JSON.stringify(loc);
    if (next !== this.locationKey) {
      this.locationKey = next; this.serial = (this.serial ?? 0) + 1;
      this.context = null; this.data = null; this.error = null; this.loading = false;
      this.tags.clear();
    }
    if (!loc.cwd || this.loading) return;
    this.loading = true;
    const serial = this.serial;
    cx.spawn(async cx => {
      const call = async mode => {
        const helper = appHome() + "/mods/forgejo-issues/backend.py";
        const args = loc.on ? ["-c", await readTextFile(helper), mode, loc.cwd] : [helper, mode, loc.cwd];
        const result = await exec(loc.on || window()?.platform !== "windows" ? "python3" : "python",
          args, { on: loc.on, timeout: 120000 });
        if (result.code !== 0) throw new Error("Forgejo helper could not run.");
        const data = JSON.parse(result.stdout);
        if (data.error) throw new Error(data.error);
        return data;
      };
      try {
        const context = await call("context");
        if (this.serial !== serial) return;
        this.context = context;
        const cached = cache.get(context.key);
        if (cached) this.data = cached;
        if (force || !cached || Date.now() - cached.time > 30000) {
          const data = await call("issues");
          data.time = Date.now(); cache.set(context.key, data);
          if (this.serial !== serial) return;
          this.context = data; this.data = data;
        }
        this.error = null;
      } catch (e) { if (this.serial === serial) this.error = String(e.message ?? e); }
      finally { if (this.serial === serial) this.loading = false; cx.notify(); }
    });
  }
  button(id, label, action, active = false, color = null) {
    const t = theme();
    return div().id(id).px(8).py(4).rounded(12).border_1().border_color(color ?? t.foreground)
      .text_color(color ?? t.foreground).cursor_pointer().bg(active ? t.selected : t.background)
      .hover(s => s.bg(t.hover)).child(label).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => action(cx));
  }
  toggleTag(label, cx) {
    const state = this.tags.get(label);
    if (state === "include") this.tags.set(label, "exclude");
    else if (state === "exclude") this.tags.delete(label);
    else this.tags.set(label, "include");
    cx.notify();
  }
  open(issue, cx) {
    const url = this.context.base + '/' + this.context.repo.split('/').map(encodeURIComponent).join('/') + '/issues/' + issue.number;
    cx.spawn(async cx => {
      try {
        const platform = window()?.platform;
        const r = await exec(platform === "windows" ? "rundll32.exe" : platform === "macos" ? "open" : "xdg-open",
          platform === "windows" ? ["url.dll,FileProtocolHandler", url] : [url]);
        if (r.code !== 0) throw new Error();
      } catch { this.error = "Could not open the issue in your browser."; }
      cx.notify();
    });
  }
  render(cx) {
    const t = theme();
    if (props()?.button) return h_flex().size_full().items_center().justify_center().text_size(12).text_color(t.muted)
      .child(this.button("forgejo-button", "Issues", () => {
        const root = layout(), active = !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "forgejo-issues";
        if (active) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "forgejo-issues" }); run("layout.show", { id: "panel" }); }
      }));
    const loc = JSON.stringify(location());
    if (!checking() && (loc !== this.locationKey || (this.visible() && Date.now() - (this.checkedAt ?? 0) > 5000))) {
      this.checkedAt = Date.now(); this.refresh(cx);
    }
    const query = this.search.value().toLowerCase();
    const labels = [...new Set([...(this.data?.labels ?? []), ...(this.data?.issues ?? []).flatMap(i => i.labels)])].sort((a, b) => a.localeCompare(b));
    const rows = (this.data?.issues ?? []).filter(i => (this.state === "all" || i.state === this.state)
      && [...this.tags].every(([label, mode]) => mode === "include" ? i.labels.includes(label) : !i.labels.includes(label))
      && `${i.number} ${i.title} ${i.labels.join(' ')} ${i.assignees.join(' ')}`.toLowerCase().includes(query))
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    // Bound native element creation: large repositories can otherwise exceed
    // Herdr's per-render execution budget when every issue is built eagerly.
    const filterKey = JSON.stringify([this.locationKey, query, this.state, [...this.tags]]);
    if (filterKey !== this.filterKey) { this.filterKey = filterKey; this.page = 0; }
    const pageCount = Math.max(1, Math.ceil(rows.length / 20));
    this.page = Math.min(this.page ?? 0, pageCount - 1);
    const visibleRows = rows.slice(this.page * 20, (this.page + 1) * 20);
    return v_flex().id("forgejo-issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center()
        .child(div().flex_1().font_semibold().child("Forgejo Issues"))
        .child(this.button("refresh", this.loading ? "Loading..." : "Refresh", cx => this.refresh(cx, true))))
      .child(div().px(10).pb(6).text_color(t.muted).child(this.context ? this.context.repo : "Follow focused repository"))
      .child(h_flex().px(8).py(6).gap(5).items_center().flex_none()
        .children(["open", "closed", "all"].map(state => this.button(state, state,
          cx => { this.state = state; cx.notify(); }, this.state === state)))
        .child(div().flex_1().min_w(0).px(8).rounded(12).border_1().border_color(t.foreground).bg(t.raised)
          .child(Input.new(this.search).h(28).text_size(12).text_color(t.foreground))))
      .when(labels.length > 0, el => el.child(v_flex().px(8).pb(8).gap(6).flex_none().id("tag-filters")
        .child(h_flex().flex_none().items_center().gap(8).child(div().text_color(t.muted).child("Tags · ✓ include · ✕ exclude"))
          .when(this.tags.size > 0, el => el.child(this.button("clear-tags", "Clear", cx => { this.tags.clear(); cx.notify(); }))))
        .child(h_flex().flex_none().flex_wrap().gap(5).children(labels.map(label => this.button(`tag-${label}`,
          (this.tags.get(label) === "include" ? "✓ " : this.tags.get(label) === "exclude" ? "✕ " : "") + label,
          cx => this.toggleTag(label, cx), this.tags.has(label), labelColor(label, t)))))))
      .when(Boolean(this.error), el => el.child(div().p(10).text_color(t.blocked).child(this.error + (this.data ? " Showing cached issues." : ""))))
      .child(div().h(1).flex_none().bg(t.foreground))
      .child(v_flex().id("issue-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(7)
        .children(visibleRows.map(i => v_flex().id(`issue-${i.number}`).p(9).gap(7).rounded(10).border_1().border_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.open(i, cx))
          .child(div().text_color(t.foreground).child(`#${i.number}  ${i.title}`))
          .child(h_flex().flex_wrap().gap(6).items_center().text_size(11)
            .child(div().px(7).py(2).rounded(10).border_1().border_color(i.state === "open" ? t.ansi2 : t.muted)
              .text_color(i.state === "open" ? t.ansi2 : t.muted).child(i.state))
            .children(i.labels.map(label => {
              const color = labelColor(label, t);
              return div().id(`issue-${i.number}-tag-${label}`).px(7).py(2).rounded(10).border_1().border_color(color).text_color(color).child(label)
                .on_click((_e, cx) => { cx.stop_propagation(); this.toggleTag(label, cx); });
            }))
            .children(i.assignees.map(a => div().text_color(t.dim).child('@' + a))))))
        .when(!rows.length && !this.loading && !this.error, el => el.child(div().p(10).text_color(t.dim).child("No matching issues."))))
      .child(div().h(1).flex_none().bg(t.foreground))
      .child(h_flex().px(10).py(6).gap(8).items_center().flex_none()
        .when(pageCount > 1, el => el.child(this.button("previous-page", "Previous", cx => { this.page = Math.max(0, this.page - 1); cx.notify(); })))
        .child(div().font_semibold().text_color(t.foreground)
          .child(`${rows.length ? this.page * 20 + 1 : 0}–${Math.min((this.page + 1) * 20, rows.length)} / ${rows.length}${this.data?.limited ? '+' : ''}`))
        .when(pageCount > 1, el => el.child(this.button("next-page", "Next", cx => { this.page = Math.min(pageCount - 1, this.page + 1); cx.notify(); }))));
  }
}
