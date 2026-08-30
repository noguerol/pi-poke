// Poke config: read the optional `poke` block from settings.json (global and
// project). Loaded lazily by the entry when restoring state at session start.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

interface PokeState {
	enabled: boolean;
	thresholdSeconds: number;
	autoAbort: boolean;
	autoPoke: boolean;
	// Post-compaction wake-up
	postCompactPoke: boolean;
	postCompactCooldownSeconds: number;
	postCompactMaxPokes: number;
}

// Read configuration from settings.json
function loadConfigFromSettings(ctx: ExtensionContext): Partial<PokeState> {
	const config: Partial<PokeState> = {};

	// Try to read from settings.json (global and project)
	try {
		const globalSettingsPath = join(process.env.HOME || "~", CONFIG_DIR_NAME, "settings.json");
		if (existsSync(globalSettingsPath)) {
			const globalSettings = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
			if (globalSettings.poke) {
				Object.assign(config, globalSettings.poke);
			}
		}
	} catch (e) {
		// Ignore read errors
	}

	// Project settings (when available)
	try {
		const projectSettingsPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
		if (existsSync(projectSettingsPath)) {
			const projectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
			if (projectSettings.poke) {
				Object.assign(config, projectSettings.poke);
			}
		}
	} catch (e) {
		// Ignore read errors
	}

	return config;
}

export { loadConfigFromSettings };
