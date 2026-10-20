import { MarkdownView, Plugin, TFile, getLinkpath } from "obsidian";

const DEBOUNCE_MS = 2000;

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

/** Pure helper: pull `[[target|alias]]` aliases out of a link's raw text. */
export function parseAlias(original: string): string | null {
	const m = /^\[\[[^|\]]*\|([^\]]*)\]\]$/.exec(original);
	if (!m) return null;
	const alias = m[1].trim();
	return alias === "" ? null : alias;
}

export default class AliasOnLinkPlugin extends Plugin {
	private timers = new Map<string, number>();

	async onload() {
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.schedule(file);
			})
		);
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

	/** True while the cursor is inside the link, i.e. the alias is probably still being typed. */
	private isEditingLink(file: TFile, start: number, end: number): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== file.path) return false;
		const offset = view.editor.posToOffset(view.editor.getCursor());
		return offset > start && offset < end;
	}

	private async processLinks(file: TFile) {
		const cache = this.app.metadataCache.getFileCache(file);
		const links = cache?.links ?? [];
		let pending = false;
		for (const link of links) {
			const alias = parseAlias(link.original);
			if (!alias) continue;
			if (this.isEditingLink(file, link.position.start.offset, link.position.end.offset)) {
				pending = true;
				continue;
			}
			const target = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link.link), file.path);
			if (!target || target.extension !== "md" || target.path === file.path) continue;
			if (alias === target.basename) continue;
			try {
				await this.app.fileManager.processFrontMatter(target, (fm) => {
					const merged = mergeAlias(fm.aliases, alias);
					if (merged) fm.aliases = merged;
				});
			} catch (e) {
				console.error("[alias-on-link] failed to update", target.path, e);
			}
		}
		if (pending) this.schedule(file);
	}
}
