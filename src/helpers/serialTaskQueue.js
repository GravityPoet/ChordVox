class SerialTaskQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    if (typeof task !== "function") {
      return Promise.reject(new TypeError("SerialTaskQueue requires a task function"));
    }

    const next = this.tail.catch(() => {}).then(() => task());
    this.tail = next.catch(() => {});
    return next;
  }

  async drain() {
    await this.tail;
  }
}

module.exports = { SerialTaskQueue };
