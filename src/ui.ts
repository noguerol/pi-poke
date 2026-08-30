// Poke UI: the /poke config TUI dialog. Loaded lazily by the entry only when
// the user runs /poke config. `state` is the shared mutable extension state
// and `persist` writes it back to the session entry.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

async function showConfigDialog(
	ctx: ExtensionContext,
	state: PokeState,
	persist: (ctx: ExtensionContext) => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/poke config requires TUI mode", "error");
		return;
	}

	const { Container, SettingsList } = await import("@earendil-works/pi-tui");
	const { getSettingsListTheme } = await import("@earendil-works/pi-coding-agent");

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const items = [
			{
				id: "enabled",
				label: "Auto-poke enabled",
				currentValue: state.enabled ? "yes" : "no",
				values: ["yes", "no"],
			},
			{
				id: "threshold",
				label: `Threshold (seconds): ${state.thresholdSeconds}`,
				currentValue: state.thresholdSeconds.toString(),
				values: ["10", "30", "60", "120", "300"],
			},
			{
				id: "autoAbort",
				label: "Auto-abort on timeout",
				currentValue: state.autoAbort ? "yes" : "no",
				values: ["yes", "no"],
			},
			{
				id: "autoPoke",
				label: "Auto-poke the agent",
				currentValue: state.autoPoke ? "yes" : "no",
				values: ["yes", "no"],
			},
			{
				id: "postCompactPoke",
				label: "Post-compaction auto-poke",
				currentValue: state.postCompactPoke ? "yes" : "no",
				values: ["yes", "no"],
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
						"",
					];
				}
				invalidate() {}
			})(),
		);

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "enabled":
						state.enabled = newValue === "yes";
						break;
					case "threshold":
						state.thresholdSeconds = parseInt(newValue, 10);
						items[1]!.label = `Threshold (seconds): ${state.thresholdSeconds}`;
						break;
					case "autoAbort":
						state.autoAbort = newValue === "yes";
						// If auto-abort is active, disable auto-poke
						if (state.autoAbort && state.autoPoke) {
							state.autoPoke = false;
							items[3]!.currentValue = "no";
						}
						break;
					case "autoPoke":
						state.autoPoke = newValue === "yes";
						// If auto-poke is active, disable auto-abort
						if (state.autoPoke && state.autoAbort) {
							state.autoAbort = false;
							items[2]!.currentValue = "no";
						}
						break;
					case "postCompactPoke":
						state.postCompactPoke = newValue === "yes";
						break;
				}
				persist(ctx);

				// Refresh UI via updateValue (SettingsList has no refresh)
				settingsList.updateValue("enabled", state.enabled ? "yes" : "no");
				settingsList.updateValue("autoAbort", state.autoAbort ? "yes" : "no");
				settingsList.updateValue("autoPoke", state.autoPoke ? "yes" : "no");
				settingsList.updateValue("postCompactPoke", state.postCompactPoke ? "yes" : "no");
			},
			() => {
				done(undefined);
			},
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
