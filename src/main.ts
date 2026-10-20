import { CachedMetadata, Plugin, TFile, getLinkpath } from "obsidian";

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
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				this.schedule(file, cache);
			})
		);
	}

	onunload() {
		this.timers.forEach((t) => window.clearTimeout(t));
		this.timers.clear();
	}

	private schedule(file: TFile, cache: CachedMetadata) {
		const prev = this.timers.get(file.path);
		if (prev !== undefined) window.clearTimeout(prev);
		const t = window.setTimeout(() => {
			this.timers.delete(file.path);
			void this.processLinks(file, cache);
		}, DEBOUNCE_MS);
		this.timers.set(file.path, t);
	}

	private async processLinks(file: TFile, cache: CachedMetadata) {
		const links = cache.links ?? [];
		for (const link of links) {
			const alias = parseAlias(link.original);
			if (!alias) continue;
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
	}
}
