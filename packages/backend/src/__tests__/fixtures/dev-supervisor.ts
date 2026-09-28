/**
 * `supervisor.ts dev` for process-level tests: the dev server and the dev node, without the frontend
 * watchers (they would write the checkout's frontend build output).
 */
import { createServices, runSupervisor } from "../../supervisor.js";

const repoRoot = new URL("../../../../../", import.meta.url).pathname;
const services = createServices("dev", repoRoot).filter(service => service.name === "server" || service.name === "node");
process.exit(await runSupervisor(services, "dev"));
