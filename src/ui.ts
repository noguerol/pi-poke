// Poke UI: the /poke config TUI dialog. Loaded lazily by the entry only when
// the user runs /poke config. `state` is the shared mutable extension state
// and `persist` writes it back to the session entry.
//
// The dialog is built on pi's native extension UI primitives:
//   - ctx.ui.custom()         -> hosts a custom TUI component with focus
//   - SettingsList (pi-tui)   -> the same settings panel pi itself uses
//   - submenu + Input (pi-tui)-> free-form numeric entry, the pattern pi uses
//                                for its own settings submenus (e.g. Theme)
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";

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

const YES_NO = ["yes", "no"];

/**
 * Build a "value" SettingItem: Enter/Space cycles through the values.
 */
function toggleItem(
	id: string,
	label: string,
	description: string,
	current: boolean,
): {
	id: string;
	label: string;
	description: string;
	currentValue: string;
	values: string[];
} {
	return {
		id,
		label,
		description,
		currentValue: current ? "yes" : "no",
		values: YES_NO,
	};
}

async function showConfigDialog(
	ctx: ExtensionContext,
	state: PokeState,
	persist: (ctx: ExtensionContext) => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"/poke config requires TUI mode — use /poke status, /poke threshold <s>, /poke postcompact <on|off> or settings.json instead",
			"error",
		);
		return;
	}

	const { Container, Text, Spacer, Input, type SettingItem, SettingsList } = await import("@earendil-works/pi-tui");

	await ctx.ui.custom((tui, theme, _kb, done) => {
		// ------------------------------------------------------------------
		// Numeric submenu: free-form input pre-filled with the current value.
		// Enter applies, Esc cancels. Same pattern pi uses for its own
		// settings submenus that need free input.
		// ------------------------------------------------------------------
		function numericSubmenu(
			title: string,
			description: string,
			presets: number[],
			currentValue: number,
			min: number,
			onApply: (value: number) => void,
			subDone: (value?: string, options?: { navigateTo?: string }) => void,
		): {
			render(width: number): string[];
			invalidate(): void;
			handleInput?(data: string): void;
		} {
			const input = new Input();
			input.setValue(String(currentValue));
			// Pre-filled value: move the cursor to the end so typing appends
			input.handleInput("\x05"); // ctrl+e -> cursorLineEnd
			input.onSubmit = (value) => {
				const num = parseInt(value.trim(), 10);
				if (Number.isNaN(num) || num < min) {
					ctx.ui.notify(`Invalid value: must be a number >= ${min}`, "warning");
					return;
				}
				onApply(num);
			};
			input.onEscape = () => subDone();

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
			container.addChild(new Text(theme.fg("muted", description), 0, 0));
			container.addChild(new Text(theme.fg("dim", `Presets: ${presets.join(" / ")} — type any number`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(input);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					input.handleInput(data);
					tui.requestRender();
				},
			};
		}

		const items: SettingItem[] = [
			toggleItem("enabled", "Auto-poke enabled", "Master switch for the whole extension", state.enabled),
			{
				id: "threshold",
				label: "Tool-call threshold",
				description: "A tool call running longer than this is considered long",
				currentValue: `${state.thresholdSeconds}s`,
				submenu: (currentValue, subDone) =>
					numericSubmenu(
						"Tool-call threshold (seconds)",
						"Warn/abort/poke when a tool call runs longer than this",
						[10, 30, 60, 120, 300],
						state.thresholdSeconds,
						1,
						(value) => {
							state.thresholdSeconds = value;
							persist(ctx);
							subDone(`${value}s`, { navigateTo: "threshold" });
						},
						subDone,
					),
			},
			toggleItem("autoAbort", "Auto-abort on timeout", "Abort the tool call when the threshold is exceeded", state.autoAbort),
			toggleItem("autoPoke", "Auto-poke the agent", "Send a steering message when a tool call runs long", state.autoPoke),
			toggleItem("postCompactPoke", "Post-compaction auto-poke", "Resume the turn after a compaction killed the work", state.postCompactPoke),
			{
				id: "cooldown",
				label: "Post-compaction cooldown",
				description: "Minimum seconds between post-compaction pokes (anti-loop)",
				currentValue: `${state.postCompactCooldownSeconds}s`,
				submenu: (currentValue, subDone) =>
					numericSubmenu(
						"Post-compaction cooldown (seconds)",
						"Wait at least this long between post-compaction pokes",
						[10, 30, 60, 120],
						state.postCompactCooldownSeconds,
						0,
						(value) => {
							state.postCompactCooldownSeconds = value;
							persist(ctx);
							subDone(`${value}s`, { navigateTo: "cooldown" });
						},
						subDone,
					),
			},
			{
				id: "maxPokes",
				label: "Max pokes per episode",
				description: "Maximum number of post-compaction pokes per stall episode (anti-loop)",
				currentValue: `${state.postCompactMaxPokes}`,
				submenu: (currentValue, subDone) =>
					numericSubmenu(
						"Max pokes per episode",
						"Poke stops insisting after this many failed recovery attempts",
						[1, 2, 3, 5],
						state.postCompactMaxPokes,
						1,
						(value) => {
							state.postCompactMaxPokes = value;
							persist(ctx);
							subDone(`${value}`, { navigateTo: "maxPokes" });
						},
						subDone,
					),
			},
		];

		const container = new Container();
		container.addChild(
			new (class {
				render(_width: number) {
					return [
						theme.fg("accent", theme.bold("⚡ Poke Extension Configuration")),
						"",
						theme.fg("dim", "Monitors long tool calls and resumes the turn after compaction"),
						theme.fg("dim", "Enter/Space cycles toggles · Enter on a number opens free input · Esc exits"),
						"",
					];
				}
				invalidate() {}
			})(),
		);

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 12),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "enabled":
						state.enabled = newValue === "yes";
						break;
					case "autoAbort":
						state.autoAbort = newValue === "yes";
						// If auto-abort is active, auto-poke is meaningless: disable it
						if (state.autoAbort && state.autoPoke) {
							state.autoPoke = false;
							settingsList.updateValue("autoPoke", "no");
						}
						break;
					case "autoPoke":
						state.autoPoke = newValue === "yes";
						// If auto-poke is active, auto-abort must be off (they exclude each other)
						if (state.autoPoke && state.autoAbort) {
							state.autoAbort = false;
							settingsList.updateValue("autoAbort", "no");
						}
						break;
					case "postCompactPoke":
						state.postCompactPoke = newValue === "yes";
						break;
				}
				persist(ctx);
			},
			() => {
				done(undefined);
			},
			{ enableSearch: true },
		);

		container.addChild(settingsList);

		const component = {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};

		return component;
	});
}

export { showConfigDialog };
