import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, getLinkpath } from "obsidian";

const DEBOUNCE_MS = 3000;
const CREATE_DELAY_MS = 1500;
const NEW_NOTE_TEMPLATE = "---\naliases:\n  - \n---\n";

/** Pure helper: merge a new alias into a frontmatter `aliases` value. Returns null if no change is needed. */
export function mergeAlias(current: unknown, alias: string): string[] | null {
	let list: string[];
	if (current == null) list = [];
	else if (Array.isArray(current)) list = current.filter((v) => v != null && String(v).trim() !== "").map((v) => String(v));
	else if (typeof current === "string") list = current.trim() === "" ? [] : [current];
	else return null;
	if (list.includes(alias)) return null;
	return [...list, alias];
}

/** Pure helper: split "a, b，c、d" into trimmed, non-empty, de-duplicated aliases. */
export function splitAliases(input: string): string[] {
	const out: string[] = [];
	for (const part of input.split(/[,，、]/)) {
		const a = part.trim();
		if (a !== "" && !out.includes(a)) out.push(a);
	}
	return out;
}

export interface AliasLink {
	linkpath: string;
	alias: string;
	start: number;
	end: number;
}

/** Pure helper: find `[[target|alias]]` links (not embeds) in text. */
export function findAliasLinks(text: string): AliasLink[] {
	const result: AliasLink[] = [];
	const re = /(!?)\[\[([^\[\]|\n]+)\|([^\[\]\n]*)\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m[1] === "!") continue;
		const alias = m[3].trim();
		if (alias === "") continue;
		result.push({ linkpath: m[2], alias, start: m.index, end: m.index + m[0].length });
	}
	return result;
}

interface AliasOnLinkSettings {
	addToNewNotes: boolean;
}

const DEFAULT_SETTINGS: AliasOnLinkSettings = { addToNewNotes: true };

export default class AliasOnLinkPlugin extends Plugin {
	settings: AliasOnLinkSettings = DEFAULT_SETTINGS;
	private timers = new Map<string, number>();

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new AliasOnLinkSettingTab(this.app, this));

		this.addCommand({
			id: "add-alias",
			name: "Add alias",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.promptAliases(file);
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, view) => {
			const file = view.file;
			if (!file || file.extension !== "md") return;
			menu.addItem((item) => item.setTitle("Add alias").setIcon("tag").onClick(() => this.promptAliases(file)));
		}));
		this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
			if (info.file) this.schedule(info.file);
		}));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.schedule(file)));

		// A note created later (e.g. by clicking an unresolved link) should get the aliases of links already pointing at it.
		// Registered after layout is ready so the startup flood of "create" events is ignored.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", (f) => {
				if (!(f instanceof TFile) || f.extension !== "md") return;
				window.setTimeout(() => {
					void this.addEmptyAliases(f);
					void this.processBacklinks(f);
				}, CREATE_DELAY_MS);
			}));
		});
	}

	private promptAliases(file: TFile) {
		new AddAliasModal(this.app, (input) => void this.addAliases(file, splitAliases(input))).open();
	}

	private async addAliases(file: TFile, aliases: string[]) {
		if (aliases.length === 0) return;
		let added = 0;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				let current: unknown = fm.aliases;
				for (const alias of aliases) {
					const merged = mergeAlias(current, alias);
					if (merged) {
						current = merged;
						added++;
					}
				}
				if (added > 0) fm.aliases = current;
			});
			new Notice(added > 0 ? `Added ${added} alias${added > 1 ? "es" : ""}` : "Those aliases already exist");
		} catch (e) {
			console.error("[alias-on-link] failed to add aliases to", file.path, e);
			new Notice("Failed to add aliases");
		}
	}

	/** Give a brand-new, still-empty note an empty `aliases` property. Notes with any content (templates, synced files) are left alone. */
	private async addEmptyAliases(file: TFile) {
		if (!this.settings.addToNewNotes) return;
		try {
			await this.app.vault.process(file, (data) => (data.trim() === "" ? NEW_NOTE_TEMPLATE : data));
		} catch (e) {
			console.error("[alias-on-link] failed to add aliases to", file.path, e);
		}
	}

	private async processBacklinks(created: TFile) {
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const source of Object.keys(resolved)) {
			if (!resolved[source][created.path]) continue;
			const file = this.app.vault.getAbstractFileByPath(source);
			if (file instanceof TFile) await this.processLinks(file);
		}
	}

	onunload() {
		this.timers.forEach((t) => window.clearTimeout(t));
		this.timers.clear();
	}

	private schedule(file: TFile) {
		const prev = this.timers.get(file.path);
		if (prev !== undefined) window.clearTimeout(prev);
		const t = window.setTimeout(() => {
			this.timers.delete(file.path);
			void this.processLinks(file);
		}, DEBOUNCE_MS);
		this.timers.set(file.path, t);
	}

	private async processLinks(file: TFile) {
		// Read the live editor text when the note is open, so link positions and the cursor agree.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view && view.file?.path === file.path ? view.editor : null;
		const text = editor ? editor.getValue() : await this.app.vault.cachedRead(file);
		const cursor = editor ? editor.posToOffset(editor.getCursor()) : -1;

		let pending = false;
		for (const link of findAliasLinks(text)) {
			if (cursor > link.start && cursor < link.end) {
				pending = true; // still typing inside this link
				continue;
			}
			const target = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link.linkpath), file.path);
			if (!target || target.extension !== "md" || target.path === file.path) continue;
			if (link.alias === target.basename) continue;
			try {
				await this.app.fileManager.processFrontMatter(target, (fm) => {
					const merged = mergeAlias(fm.aliases, link.alias);
					if (merged) fm.aliases = merged;
				});
			} catch (e) {
				console.error("[alias-on-link] failed to update", target.path, e);
			}
		}
		if (pending) this.schedule(file);
	}
}

class AliasOnLinkSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AliasOnLinkPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Add empty aliases to new notes")
			.setDesc("When a new empty note is created, add an aliases property with one empty list item. Notes created with content (e.g. from a template) are not touched.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.addToNewNotes).onChange(async (v) => {
					this.plugin.settings.addToNewNotes = v;
					await this.plugin.saveData(this.plugin.settings);
				})
			);
	}
}

class AddAliasModal extends Modal {
	constructor(app: App, private onSubmit: (input: string) => void) {
		super(app);
	}

	onOpen() {
		this.setTitle("Add alias");
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "alias1, alias2, alias3",
		});
		input.style.width = "100%";
		const submit = () => {
			const value = input.value;
			this.close();
			this.onSubmit(value);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Add").setCta().onClick(submit));
		input.focus();
	}

	onClose() {
		this.contentEl.empty();
	}
}
