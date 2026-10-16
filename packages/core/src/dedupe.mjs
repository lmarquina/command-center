// Remembers the last `max` ids so replayed events are emitted once.
export class Deduper {
  constructor(max = 5000) { this.max = max; this.seen = new Set(); }
  firstTime(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.max) this.seen.delete(this.seen.values().next().value);
    return true;
  }
}
