class SidecarCoordinator {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this.entries = new Map();
    this.generation = 0;
    this.shuttingDown = false;
  }

  register(name, manager) {
    const key = String(name || "").trim();
    if (!key || !manager) return null;
    this.entries.set(key, { name: key, manager, lease: null });
    return manager;
  }

  begin(name, owner = "operation") {
    const entry = this.entries.get(String(name || ""));
    if (!entry || this.shuttingDown) return null;
    const token = Object.freeze({
      name: entry.name,
      owner: String(owner || "operation"),
      generation: ++this.generation,
    });
    entry.lease = token;
    return token;
  }

  isCurrent(token) {
    if (!token || this.shuttingDown) return false;
    const entry = this.entries.get(token.name);
    return Boolean(entry && entry.lease === token);
  }

  async stopOwned(token, reason = "stale-owner") {
    if (!token || !this.isCurrent(token)) {
      return { success: true, skipped: true, reason: "superseded" };
    }
    const entry = this.entries.get(token.name);
    entry.lease = null;
    try {
      const result = await entry.manager.stopServer?.();
      return { ...(result || {}), success: result?.success !== false, stopped: true, reason };
    } catch (error) {
      this.logger?.debug?.("Sidecar owner stop failed", {
        sidecar: token.name,
        owner: token.owner,
        reason,
        error: error?.message || String(error),
      });
      return { success: false, error: error?.message || String(error), reason };
    }
  }

  async stop(name, { force = false, reason = "stop" } = {}) {
    const entry = this.entries.get(String(name || ""));
    if (!entry) return { success: true, skipped: true, reason: "unknown-sidecar" };
    if (entry.lease && !force) {
      return { success: true, skipped: true, reason: "owned-by-active-operation" };
    }
    const lease = entry.lease;
    entry.lease = null;
    try {
      const result = await entry.manager.stopServer?.();
      return { ...(result || {}), success: result?.success !== false, stopped: true, reason };
    } catch (error) {
      this.logger?.debug?.("Sidecar stop failed", {
        sidecar: entry.name,
        reason,
        owner: lease?.owner || null,
        error: error?.message || String(error),
      });
      return { success: false, error: error?.message || String(error), reason };
    }
  }

  async stopExcept(selectedName = "", reason = "reconcile") {
    const selected = String(selectedName || "");
    const tasks = [];
    for (const entry of this.entries.values()) {
      if (entry.name === selected) continue;
      const force = !entry.lease || String(entry.lease.owner || "").startsWith("prewarm:");
      tasks.push(this.stop(entry.name, { force, reason }));
    }
    return Promise.all(tasks);
  }

  async stopAll(reason = "shutdown") {
    this.shuttingDown = true;
    const tasks = [];
    for (const entry of this.entries.values()) {
      tasks.push(this.stop(entry.name, { force: true, reason }));
    }
    return Promise.all(tasks);
  }

  resetAfterResume() {
    this.shuttingDown = false;
    for (const entry of this.entries.values()) {
      entry.lease = null;
    }
  }
}

module.exports = SidecarCoordinator;
