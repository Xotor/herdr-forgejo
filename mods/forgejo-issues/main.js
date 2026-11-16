import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, checking, exec, focused, layout, panes, props, readTextFile, run, spaces, theme, window, shared, setShared } from "herdr";

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
  get kind() { return "issues"; }
  get modName() { return "forgejo-" + this.kind; }
  get title() { return this.kind === "prs" ? "Pull Requests" : this.kind === "actions" ? "Actions" : "Issues"; }
  init(_p, cx) {
    this.state = this.kind === "actions" ? "all" : "open"; this.tags = new Map();
    this.actionStates = new Set();
    this.sortBy = "updated_at"; this.sortDirection = "desc";
    this.search = InputState.new({ placeholder: "Search " + this.title.toLowerCase() + "..." });
    this.search.on("change", (_e, cx) => cx.notify());
    this.error = null;
    if (checking() || props()?.button) return;
    this.refresh(cx);
    cx.timer.every(30000, cx => { if (this.visible() && !this.error) this.refresh(cx, true); });
    cx.timer.every(5000, cx => this.checkDeadline(cx));
  }
  checkDeadline(cx, now = Date.now()) {
    if ((this.loading || this.enriching) && now > this.deadline) {
      this.serial++; this.loading = false; this.enriching = false;
      this.error = this.data ? "Link lookup timed out. Showing the loaded list; use Refresh to retry." : "Loading timed out. Check the connection and use Refresh to retry.";
      cx.notify();
    }
  }
  visible() { const root = layout(); return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === this.modName; }
  refresh(cx, force = false) {
    if (checking() || props()?.button) return;
    const loc = location(), next = JSON.stringify(loc);
    if (next !== this.locationKey) {
      this.locationKey = next; this.serial = (this.serial ?? 0) + 1;
      this.context = null; this.data = null; this.error = null; this.loading = false; this.enriching = false;
      this.tags.clear();
      this.related = null;
    }
    if (!loc.cwd || this.loading || this.enriching) return;
    this.loading = true;
    this.error = null; this.deadline = Date.now() + 60000;
    const serial = this.serial;
    cx.spawn(async cx => {
      const call = async mode => {
        const helper = appHome() + "/mods/" + this.modName + "/backend.py";
        const args = loc.on ? ["-c", await readTextFile(helper), mode, loc.cwd] : [helper, mode, loc.cwd];
        const result = await exec(loc.on || window()?.platform !== "windows" ? "python3" : "python",
          args, { on: loc.on, timeout: mode === "context" ? 15000 : 55000 });
        if (result.code !== 0) throw new Error("Forgejo helper could not run.");
        const data = JSON.parse(result.stdout);
        if (data.error) throw new Error(data.error);
        return data;
      };
      try {
        const context = await call("context");
        if (this.serial !== serial) return;
        this.context = context;
        cx.notify();
        const cached = cache.get(context.key);
        if (cached) this.data = cached;
        if (force || !cached || Date.now() - cached.time > 30000) {
          if (!cached) {
            const primary = await call("panel:" + this.kind);
            if (this.serial !== serial) return;
            this.data = primary; this.context = primary; this.loading = false;
            cx.notify();
          }
          this.enriching = true; this.deadline = Date.now() + 60000;
          const data = await call("board");
          data.time = Date.now(); cache.set(context.key, data);
          if (this.serial !== serial) return;
          this.context = data; this.data = data;
        }
        this.error = null;
      } catch (e) { if (this.serial === serial) this.error = String(e.message ?? e); }
      finally { if (this.serial === serial) { this.loading = false; this.enriching = false; } cx.notify(); }
    });
  }
  button(id, label, action, active = false, color = null) {
    const t = theme();
    return div().id(id).px(8).py(4).rounded(12).border_1().border_color(color ?? t.foreground)
      .text_color(color ?? t.foreground).cursor_pointer().bg(active ? t.selected : t.background)
      .hover(s => s.bg(t.hover)).child(label).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(cx); });
  }
  toggleTag(label, cx) {
    const state = this.tags.get(label);
    if (state === "include") this.tags.set(label, "exclude");
    else if (state === "exclude") this.tags.delete(label);
    else this.tags.set(label, "include");
    cx.notify();
  }
  relatedTo(issue, kind) {
    setShared("forgejo.navigate", { key: this.context.key, kind, fromKind: this.kind, fromNumber: issue.number, stamp: Date.now() });
    run("layout.select", { stack: "panel-body", child: "forgejo-" + kind });
    run("layout.show", { id: "panel" });
  }
  statusColor(state, t) {
    return ["open", "success"].includes(state) ? t.ansi2 : ["failure", "failed", "cancelled", "canceled", "blocked"].includes(state) ? t.ansi1
      : ["running", "in_progress"].includes(state) ? t.ansi4 : ["waiting", "queued", "pending"].includes(state) ? t.ansi3 : state === "merged" ? t.ansi5 : t.muted;
  }
  toggleState(state, cx) {
    if (this.kind !== "actions") this.state = state;
    else if (state === "all") this.actionStates.clear();
    else if (this.actionStates.has(state)) this.actionStates.delete(state);
    else this.actionStates.add(state);
    cx.notify();
  }
  searchBox() {
    const t = theme();
    return div().flex_1().min_w(0).px(8).rounded(12).border_1().border_color(t.foreground).bg(t.raised)
      .child(Input.new(this.search).h(28).text_size(12).text_color(t.foreground));
  }
  open(issue, cx) {
    const path = this.kind === "actions" ? "actions/runs" : this.kind === "prs" ? "pulls" : "issues";
    const url = issue.web_url ?? this.context.base + '/' + this.context.repo.split('/').map(encodeURIComponent).join('/') + '/' + path + '/' + issue.number;
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
      .child(this.button("forgejo-button", this.title, () => {
        const root = layout(), active = !find(root, "panel")?.hidden && find(root, "panel-body")?.active === this.modName;
        if (active) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: this.modName }); run("layout.show", { id: "panel" }); }
      }));
    const loc = JSON.stringify(location());
    if (!checking() && loc !== this.locationKey) this.refresh(cx);
    const nav = shared("forgejo.navigate");
    if (nav?.kind === this.kind && nav.key === this.context?.key && nav.stamp !== this.navStamp) {
      this.navStamp = nav.stamp; this.related = nav; this.state = "all"; this.tags.clear();
      this.actionStates.clear();
      cx.spawn(async cx => { this.search.set_value(""); cx.notify(); });
    }
    const query = this.search.value().toLowerCase(), items = this.data?.[this.kind] ?? [];
    const labels = this.kind !== "issues" ? [] : [...new Set([...(this.data?.labels ?? []), ...items.flatMap(i => i.labels)])].sort((a, b) => a.localeCompare(b));
    const states = this.kind === "actions" ? [...new Set(["all", "running", "success", "failure", "waiting", "cancelled", ...items.map(i => actionStatus(i.state))])] : this.kind === "prs" ? ["open", "draft", "merged", "closed", "all"] : ["open", "closed", "all"];
    const rows = items.filter(i => (this.kind === "actions" ? !this.actionStates.size || this.actionStates.has(actionStatus(i.state)) : this.state === "all" || i.state === this.state)
      && (!this.related || (i.links ?? []).some(l => l.kind === this.related.fromKind && l.number === this.related.fromNumber))
      && [...this.tags].every(([label, mode]) => mode === "include" ? i.labels.includes(label) : !i.labels.includes(label))
      && `${i.number} ${i.title} ${i.detail ?? ''} ${i.sha ?? ''} ${i.labels.join(' ')} ${i.assignees.join(' ')}`.toLowerCase().includes(query))
      .sort((a, b) => compareIssues(a, b, this.sortBy ?? "updated_at", this.sortDirection ?? "desc"));
    // Bound native element creation: large repositories can otherwise exceed
    // Herdr's per-render execution budget when every issue is built eagerly.
    const filterKey = JSON.stringify([this.locationKey, query, this.state, [...this.actionStates], [...this.tags], this.sortBy, this.sortDirection, this.related]);
    if (filterKey !== this.filterKey) { this.filterKey = filterKey; this.page = 0; }
    const pageCount = Math.max(1, Math.ceil(rows.length / 20));
    this.page = Math.min(this.page ?? 0, pageCount - 1);
    const visibleRows = rows.slice(this.page * 20, (this.page + 1) * 20);
    return v_flex().id("forgejo-issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .on_size_change((size, cx) => {
        const wide = size.width >= 640;
        if (this.kind === "actions" && this.wideTiming !== wide) { this.wideTiming = wide; cx.notify(); }
      })
      .border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center()
        .child(div().flex_1().font_semibold().child("Forgejo " + this.title))
        .child(this.button("refresh", this.loading ? "Loading..." : "Refresh", cx => this.refresh(cx, true))))
      .when(Boolean(this.enriching), el => el.child(div().px(10).pb(5).text_size(11).text_color(t.dim).child("Loading history and related items...")))
      .child(div().px(10).pb(6).text_color(t.muted).child(this.context ? this.context.repo : "Follow focused repository"))
      .child(h_flex().px(8).py(6).gap(5).items_center().flex_wrap().flex_none()
        .children(states.map(state => this.button(state, (this.kind === "actions" && this.actionStates.has(state) ? "✓ " : "") + state,
          cx => this.toggleState(state, cx), this.kind === "actions" ? state === "all" ? !this.actionStates.size : this.actionStates.has(state) : this.state === state,
          this.kind === "actions" && state !== "all" ? this.statusColor(state, t) : null)))
        .when(this.kind !== "actions", el => el.child(this.searchBox())))
      .when(this.kind === "actions", el => el.child(h_flex().px(8).pb(7).flex_none().child(this.searchBox())))
      .child(h_flex().px(8).pb(7).gap(5).items_center().flex_wrap().flex_none()
        .child(div().text_color(t.muted).child("Sort"))
        .children([["number", "#"], ["created_at", "Created"], ["updated_at", "Modified"]].map(([field, label]) =>
          this.button(`sort-${field}`, label, cx => { this.sortBy = field; cx.notify(); }, (this.sortBy ?? "updated_at") === field)))
        .child(this.button("sort-direction", (this.sortDirection ?? "desc") === "asc" ? "↑ ASC" : "↓ DESC",
          cx => { this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc"; cx.notify(); })))
      .when(labels.length > 0, el => el.child(v_flex().px(8).pb(8).gap(6).flex_none().id("tag-filters")
        .child(h_flex().flex_none().items_center().gap(8).child(div().text_color(t.muted).child("Tags · ✓ include · ✕ exclude"))
          .when(this.tags.size > 0, el => el.child(this.button("clear-tags", "Clear", cx => { this.tags.clear(); cx.notify(); }))))
        .child(h_flex().flex_none().flex_wrap().gap(5).children(labels.map(label => this.button(`tag-${label}`,
          (this.tags.get(label) === "include" ? "✓ " : this.tags.get(label) === "exclude" ? "✕ " : "") + label,
          cx => this.toggleTag(label, cx), this.tags.has(label), labelColor(label, t)))))))
      .when(Boolean(this.error), el => el.child(div().p(10).text_color(t.blocked).child(this.error + (this.data ? " Showing cached issues." : ""))))
      .when(Boolean(this.data?.warnings?.length), el => el.child(div().px(8).pb(6).text_color(t.blocked).child(this.data.warnings.join("\n"))))
      .when(Boolean(this.related), el => el.child(h_flex().px(8).pb(6).gap(6).items_center().flex_none()
        .child(div().flex_1().child(`Linked to ${this.related?.fromKind} #${this.related?.fromNumber}`))
        .child(this.button("clear-related", "Clear link", cx => { this.related = null; cx.notify(); }))))
      .child(div().h(1).flex_none().bg(t.foreground))
      .child(v_flex().id("issue-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(7)
        .children(visibleRows.map(i => v_flex().id(`issue-${i.number}`).p(9).gap(7).rounded(10).border_1().border_color(this.kind === "actions" ? this.statusColor(i.state, t) : t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.open(i, cx))
          .child(div().text_color(this.kind === "actions" ? this.statusColor(i.state, t) : t.foreground).child(`#${i.number}  ${i.title}`))
          .when(Boolean(i.detail), el => el.child(div().text_color(t.muted).text_size(11).child(i.detail)))
          .when(this.kind === "actions", el => el.child(div().text_color(t.muted).text_size(11).child(actionTiming(i, Date.now(), this.wideTiming !== false))))
          .child(h_flex().flex_wrap().gap(6).items_center().text_size(11)
            .child(div().px(7).py(2).rounded(10).border_1().border_color(this.statusColor(i.state, t))
              .text_color(this.statusColor(i.state, t)).child(i.state))
            .children((this.kind === "issues" ? i.labels : []).map(label => {
              const color = labelColor(label, t);
              return div().id(`issue-${i.number}-tag-${label}`).px(7).py(2).rounded(10).border_1().border_color(color).text_color(color).child(label)
                .on_click((_e, cx) => { cx.stop_propagation(); this.toggleTag(label, cx); });
            }))
            .children(i.assignees.map(a => div().text_color(t.dim).child('@' + a))))
          .when(Boolean(i.links?.length), el => el.child(h_flex().flex_wrap().gap(5).children(["issues", "prs", "actions"].filter(kind => (i.links ?? []).some(l => l.kind === kind)).map(kind =>
            this.button(`links-${i.number}-${kind}`, `${kind === "prs" ? "PRs" : kind} (${new Set(i.links.filter(l => l.kind === kind).map(l => l.number)).size})`, cx => this.relatedTo(i, kind))))))
          .when(Boolean(i.links?.length), el => el.child(div().text_size(10).text_color(t.dim).child([...new Set(i.links.map(l => l.reason))].join(" · "))))))
        .when(!rows.length && !this.loading && !this.error, el => el.child(div().p(10).text_color(t.dim).child("No matching " + this.title.toLowerCase() + "."))))
      .child(div().h(1).flex_none().bg(t.foreground))
      .child(h_flex().px(10).py(6).gap(8).items_center().flex_none()
        .when(pageCount > 1, el => el.child(this.button("previous-page", "Previous", cx => { this.page = Math.max(0, this.page - 1); cx.notify(); })))
        .child(div().font_semibold().text_color(t.foreground)
          .child(`${rows.length ? this.page * 20 + 1 : 0}–${Math.min((this.page + 1) * 20, rows.length)} / ${rows.length}${(this.data?.limits?.[this.kind] ?? this.data?.limited) ? '+' : ''}`))
        .when(pageCount > 1, el => el.child(this.button("next-page", "Next", cx => { this.page = Math.min(pageCount - 1, this.page + 1); cx.notify(); }))));
  }
}

export function compareIssues(a, b, field, direction) {
  const value = issue => field === "number" ? Number(issue.number) || 0 : Date.parse(issue[field] ?? "") || 0;
  const difference = value(a) - value(b) || (Number(a.number) || 0) - (Number(b.number) || 0);
  return direction === "asc" ? difference : -difference;
}

export function actionStatus(state) {
  return state === "in_progress" ? "running" : ["queued", "pending"].includes(state) ? "waiting" : state === "failed" ? "failure" : state === "canceled" ? "cancelled" : state;
}
export function actionTiming(item, now = Date.now(), wide = true) {
  const timestamp = value => { const n = Date.parse(value ?? ""); return Number.isFinite(n) && n > 0 ? n : null; };
  const start = timestamp(item.started_at), finish = timestamp(item.finished_at);
  const format = n => n ? new Date(n).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
  const running = actionStatus(item.state) === 'running';
  const seconds = start && (finish || running) ? Math.max(0, Math.floor(((finish ?? now) - start) / 1000)) : item.duration_seconds > 0 ? Math.floor(item.duration_seconds) : null;
  const duration = seconds === null ? '—' : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  const elapsed = `${running ? 'Elapsed' : 'Duration'}: ${duration}`;
  return wide ? `Started: ${format(start)} · Finished: ${format(finish)} · ${elapsed}`
    : `Started: ${format(start)}\n${elapsed} · Finished: ${format(finish)}`;
}
