// What `npm run dev` runs, derived from the config. Pure: returns argv arrays for the supervisor.
import path from "node:path";

export function serviceSpecs({ config, root, node = process.execPath }) {
  const all = {
    agentd: { cmd: node, args: [path.join(root, "apps/agentd/src/agentd.mjs")] },
    gateway: { cmd: node, args: [path.join(root, "apps/gateway/src/server.mjs")] },
    glasses: { cmd: node, args: [path.join(root, "node_modules/vite/bin/vite.js")], cwd: path.join(root, "apps/glasses") },
    voice: { cmd: "/bin/sh", args: [path.join(root, "services/voice/run.sh"), "start"], env: config.voice && config.voice.modelsDir ? { CC_VOICE_MODELS: config.voice.modelsDir } : {} },
  };
  const wanted = config.stack.services;
  const unknown = wanted.filter((n) => !all[n]);
  if (unknown.length) throw Object.assign(new Error(`unknown service in config stack.services: ${unknown.join(", ")}`), { code: "BAD_CONFIG" });
  const specs = wanted.map((name) => ({ name, ...all[name] }));
  // Keep the computer awake while the stack runs (macOS built-in; ends with the stack).
  if (config.stack.keepAwake) specs.push({ name: "awake", cmd: "/usr/bin/caffeinate", args: ["-s", "-i"] });
  return specs;
}

/** The two processes `npm run sim` adds on top of a running stack: a local copy of the app and the simulator. */
export function simSpecs({ config, root, token, node = process.execPath }) {
  const appPort = config.gateway.glasses.appPort + 1;
  return [
    { name: "sim-app", cmd: node, args: [path.join(root, "node_modules/vite/bin/vite.js")], cwd: path.join(root, "apps/glasses"), env: { CC_PLAIN: "1" } },
    { name: "simulator", cmd: node, args: [path.join(root, "node_modules/@evenrealities/evenhub-simulator/bin/index.js"), "--automation-port", String(config.stack.simAutomationPort), `http://127.0.0.1:${appPort}/#t=${token}`] },
  ];
}
