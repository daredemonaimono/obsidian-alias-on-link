import { MarkdownView, Plugin, TFile, getLinkpath } from "obsidian";

const DEBOUNCE_MS = 3000;

/** Pure helper: merge a new alias into a frontmatter `aliases` value. Returns null if no change is needed. */
export function mergeAlias(current: unknown, alias: string): string[] | null {
	let list: string[];
	if (current == null) list = [];
	else if (Array.isArray(current)) list = current.map((v) => String(v));
	else if (typeof current === "string") list = current.trim() === "" ? [] : [current];
	else return null;
	if (list.includes(alias)) return null;
	return [...list, alias];
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

export default class AliasOnLinkPlugin extends Plugin {
	private timers = new Map<string, number>();

	async onload() {
		this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
			if (info.file) this.schedule(info.file);
		}));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.schedule(file)));
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
