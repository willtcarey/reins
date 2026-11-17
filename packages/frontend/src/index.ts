/**
 * Frontend Entry Point
 *
 * Imports the app shell component which registers all sub-components.
 */

// Extensions' frontend parts find <reins-markdown> in the global registry: defined before app-shell loads any.
import "./components/reins-markdown.js";
import "./components/app-workspace.js";
import "./components/project-history.js";
import "./components/settings/page.js";
import "./components/app.js";
