// Problems the extension shows in its popup and sends to the hub (docs/protocol.md, "Problems").
// One current problem per component. Components starting with "local." stay in the popup only
// (for example "the hub can't be reached", which can't be sent to the hub anyway).
//
// Stored as "problems" -> { [component]: { message, at, active, synced } }.
export class Problems {
  constructor(kv, now = () => Date.now()) { this.kv = kv; this.now = now; }

  async all() { return (await this.kv.get("problems")).problems ?? {}; }

  async report(component, message) {
    const all = await this.all();
    const cur = all[component];
    if (cur?.active && cur.message === message) return false;
    all[component] = { message: String(message).slice(0, 1000), at: this.now(), active: true, synced: false, rev: (cur?.rev ?? 0) + 1 };
    await this.kv.set({ problems: all });
    return true;
  }

  async resolve(component) {
    const all = await this.all();
    const cur = all[component];
    if (!cur?.active) return false;
    if (component.startsWith("local.")) delete all[component];
    else all[component] = { ...cur, active: false, synced: false, resolved_at: this.now(), rev: (cur.rev ?? 0) + 1 };
    await this.kv.set({ problems: all });
    return true;
  }

  async active() {
    return Object.entries(await this.all()).filter(([, p]) => p.active).map(([component, p]) => ({ component, ...p }));
  }

  // What still has to be told to the hub.
  async unsynced() {
    return Object.entries(await this.all())
      .filter(([c, p]) => !p.synced && !c.startsWith("local."))
      .map(([component, p]) => ({ component, ...p }));
  }

  async markSynced(component, rev) {
    const all = await this.all();
    const cur = all[component];
    if (!cur || cur.rev !== rev) return; // changed since it was sent
    if (cur.active) all[component] = { ...cur, synced: true };
    else delete all[component];
    await this.kv.set({ problems: all });
  }
}

export const problemBody = (p) => (p.active ? { component: p.component, message: p.message } : { component: p.component, resolved: true });
