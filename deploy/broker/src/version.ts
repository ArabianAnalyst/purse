import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The app version from package.json, read once at load. */
export const VERSION: string = (require("../package.json") as { version: string }).version;
