import path from "node:path";
import { loadConfig } from "@command-center/core/config.mjs";
import { RUN_DIR } from "@command-center/core/paths.mjs";
import { serveConfig } from "./serveConfig.mjs";

const s = serveConfig({ config: loadConfig(), tlsDir: path.join(RUN_DIR, "tls"), plain: !!process.env.CC_PLAIN });
export default { server: s.server, define: { __GLASSES_PORT__: s.glassesPort } };
