#!/usr/bin/env node
// agentd: hosts SessionCore with the configured providers behind one local Unix socket (see rpcServer.mjs).
import fs from "node:fs";
import { loadConfig } from "@command-center/core/config.mjs";
import { runPath } from "@command-center/core/paths.mjs";
import { appender } from "@command-center/core/appender.mjs";
import { buildCore } from "./factory.mjs";
import { startRpcServer } from "./rpcServer.mjs";
import { execFile } from "node:child_process";
import { healthChecks } from "./health.mjs";

const SOCK = runPath("agentd.sock"), LOG = runPath("agentd.log"), EVENTS = runPath("events.jsonl");
const writeLog = appender(LOG), writeEvent = appender(EVENTS, { maxBytes: 50e6 });
const log = (...a) => writeLog(`${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);

const config = loadConfig();
if (process.env.CC_DEMO === "1") config.demo = true;
const core = await buildCore({ config, log });
const health = await core.start();
log("providers", health);

// Live checks for the glasses' system-check screen (see health.mjs).
const bridgeClient = (core.providers.cowork || core.providers.chatgpt || {}).client;
const desktopRunning = () => new Promise((r) => execFile("/usr/bin/pgrep", ["-x", "Claude"], (e) => r(!e)));
async function checkHealth() {
  if (config.demo) return healthChecks({ providers: health, bridge: { extension: "demo", cowork: { tab: "ok", signedIn: true }, chatgpt: { tab: "ok", signedIn: true } }, desktopRunning: true });
  const bridge = bridgeClient ? await bridgeClient.request("bridge.health", {}, 30000).catch((e) => e) : undefined;
  return healthChecks({ providers: health, bridge, desktopRunning: await desktopRunning() });
}

let rpc;
async function stop(why) { log("stopping:", why); await core.stop(); if (rpc) await rpc.close(); process.exit(0); }
try {
  rpc = await startRpcServer({
    core, sockPath: SOCK, health, log, onShutdown: stop, checkHealth,
    onEvent: (e) => writeEvent(JSON.stringify({ ...e, text: e.text && e.text.slice(0, 200) })),
  });
} catch (e) { console.error(e.message); await core.stop(); process.exit(1); }
log("agentd listening", SOCK);
console.error(`agentd pid ${process.pid} listening on ${SOCK}; providers: ${JSON.stringify(health)}`);
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
