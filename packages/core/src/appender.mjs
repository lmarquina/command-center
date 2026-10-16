// Append-only log file with a size cap: past maxBytes the file becomes <file>.1 (replacing the previous one) and a
// new file starts, so a long-running service never fills the disk.
import fs from "node:fs";

export function appender(file, { maxBytes = 20e6, checkEvery = 200 } = {}) {
  let n = 0;
  const rotate = () => { try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`); } catch { /* not there yet */ } };
  rotate();
  return (line) => { if (++n % checkEvery === 0) rotate(); fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n", { mode: 0o600 }); };
}
