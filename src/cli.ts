#!/usr/bin/env node

import { Command } from 'commander';
import { Defuddle } from './node';
import { writeFile, readFile } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { parseLinkedomHTML } from './utils/linkedom-compat';
import { countWords } from './utils';
import { buildFrontmatter } from './frontmatter';
import { getInitialUA, fetchPage, extractRawMarkdown, cleanMarkdownContent, BOT_UA } from './fetch';
import { ExtractorRegistry } from './extractor-registry';
import type { DebugInfo, DebugRemoval } from './types';

export interface ParseOptions {
	output?: string;
	markdown?: boolean;
	md?: boolean;
	json?: boolean;
	debug?: boolean;
	property?: string;
	lang?: string;
	userAgent?: string;
	frontmatter?: boolean;
	sourceUrl?: string;
	extractor?: string[];
}

function collectExtractor(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

// Production CJS builds: `await import(s)` is lowered by tsc (module=CommonJS)
// to a `require(s)` equivalent that cannot resolve file:// URLs or .mjs files.
// Hide the dynamic import inside a Function() so tsc doesn't see it, and the
// expression is parsed at runtime by Node, which honours native ESM dynamic
// import.
//
// Vitest (test runs): the source TS goes through esbuild, which preserves
// `import()`. But the Function()-eval shortcut runs outside vitest's module
// graph and trips its "A dynamic import callback was not specified" check.
// Detect that environment and use the in-source `import()` form so vitest
// can hook it normally.
const __INSIDE_VITEST__ = (globalThis as Record<string, unknown>).__vitest_worker__ !== undefined;
const dynamicImport: (specifier: string) => Promise<{ default?: unknown; [k: string]: unknown }> =
	__INSIDE_VITEST__
		? ((specifier: string) => import(specifier)) as never
		: (new Function('specifier', 'return import(specifier)') as never);

async function loadExtractor(extractorPath: string): Promise<void> {
	const absPath = resolve(process.cwd(), extractorPath);
	const mod = await dynamicImport(pathToFileURL(absPath).href);
	const mapping = (mod.default ?? mod) as { patterns?: unknown; extractor?: unknown };
	if (!mapping || !Array.isArray(mapping.patterns) || typeof mapping.extractor !== 'function') {
		throw new Error(`--extractor ${extractorPath}: module must default-export { patterns: (string | RegExp)[], extractor: class }`);
	}
	ExtractorRegistry.register(mapping as { patterns: (string | RegExp)[]; extractor: new (...args: unknown[]) => unknown } as never);
}

interface ParseResult {
	output: string;
	/** Human-readable debug log, present only when --debug and not --json. */
	debugLog?: string;
}

// ANSI color helpers (avoids chalk dependency which is ESM-only)
const useColor = process.stdout.isTTY ?? false;
const ansi = {
	red: (s: string) => useColor ? `\x1b[31m${s}\x1b[39m` : s,
	green: (s: string) => useColor ? `\x1b[32m${s}\x1b[39m` : s,
};

// Read version from package.json
const version = require('../package.json').version;

export async function readStdin(input: NodeJS.ReadStream = process.stdin): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: string[] = [];
		input.setEncoding('utf8');
		input.on('data', (chunk: string) => {
			chunks.push(chunk);
		});
		input.on('end', () => resolve(chunks.join('')));
		input.on('error', reject);
	});
}

export async function parseSource(source: string | undefined, options: ParseOptions, input: NodeJS.ReadStream = process.stdin): Promise<ParseResult> {
	// Handle --md alias
	if (options.md) {
		options.markdown = true;
	}

	const defuddleOpts = {
		debug: options.debug,
		markdown: options.markdown,
		separateMarkdown: options.markdown || options.json,
		language: options.lang,
	};

	if (options.extractor && options.extractor.length > 0) {
		for (const extractorPath of options.extractor) {
			await loadExtractor(extractorPath);
		}
	}

	let html: string;
	let url: string | undefined = options.sourceUrl;

	const usesStdin = !source || source === '-';
	const isUrl = !usesStdin && (source.startsWith('http://') || source.startsWith('https://'));

	if (usesStdin) {
		if (input.isTTY) {
			throw new Error('No input source provided. Pass a file path or URL, or pipe HTML to stdin.');
		}
		html = await readStdin(input);
	} else if (isUrl) {
		// Positional URL is also the content URL; --source-url, if any, has been
		// pre-seeded into `url` above and is overwritten here intentionally so the
		// fetched URL is authoritative for a live fetch.
		url = source;
		const initialUA = options.userAgent || getInitialUA(source);
		html = await fetchPage(source, initialUA, options.lang);
	} else {
		const filePath = resolve(process.cwd(), source);
		html = await readFile(filePath, 'utf-8');
	}

	const doc = parseLinkedomHTML(html);
	let result = await Defuddle(doc, url, defuddleOpts);

	// If no content was extracted from a URL, retry with bot UA.
	// Some sites (e.g. Obsidian Publish) serve pre-rendered content to bots.
	// Skipped when the user set a UA explicitly — respect their choice.
	if (isUrl && result.wordCount === 0 && !options.userAgent) {
		try {
			const botHtml = await fetchPage(source, BOT_UA, options.lang);

			// Check for raw markdown before DOM parsing destroys whitespace
			const rawMarkdown = extractRawMarkdown(botHtml);
			if (rawMarkdown) {
				const botDoc = parseLinkedomHTML(botHtml);
				const botResult = await Defuddle(botDoc, url, defuddleOpts);
				botResult.content = cleanMarkdownContent(rawMarkdown);
				botResult.wordCount = countWords(botResult.content);
				result = botResult;
			} else {
				const botDoc = parseLinkedomHTML(botHtml);
				const botResult = await Defuddle(botDoc, url, defuddleOpts);
				if (botResult.wordCount > 0) {
					result = botResult;
				}
			}
		} catch {
			// Bot UA may be blocked — use original result
		}
	}

	// Check if parsing produced meaningful content
	const textContent = parseLinkedomHTML(`<!DOCTYPE html><html><body>${result.content}</body></html>`)
		.body.textContent?.trim() || '';
	if (!textContent) {
		throw new Error(`No content could be extracted from ${usesStdin ? 'stdin' : source}`);
	}

	// Format output
	let output: string;

	if (options.property) {
		const property = options.property;
		if (property in result) {
			output = result[property as keyof typeof result]?.toString() || '';
		} else {
			throw new Error(`Property "${property}" not found in response`);
		}
	} else if (options.json) {
		output = JSON.stringify({
			content: result.content,
			title: result.title,
			description: result.description,
			domain: result.domain,
			favicon: result.favicon,
			image: result.image,
			language: result.language,
			metaTags: result.metaTags,
			parseTime: result.parseTime,
			published: result.published,
			author: result.author,
			site: result.site,
			schemaOrgData: result.schemaOrgData,
			wordCount: result.wordCount,
			...(result.contentMarkdown ? { contentMarkdown: result.contentMarkdown } : {}),
			...(result.variables ? { variables: result.variables } : {}),
			...(result.debug ? { debug: result.debug } : {}),
		}, null, 2);
	} else {
		output = options.frontmatter ? buildFrontmatter(result, url) + result.content : result.content;
	}

	// Surface debug info when --debug was set without --json. The content
	// goes to stdout (unchanged); the debug log goes to stderr so it does
	// not corrupt the primary output stream. We format it here so callers
	// (tests, action wrapper) can route it wherever they want.
	const debugLog = options.debug && !options.json && result.debug
		? formatDebugLog(result.debug)
		: undefined;

	return { output, debugLog };
}

function formatDebugLog(debug: DebugInfo): string {
	const lines: string[] = [];
	lines.push(`# defuddle --debug`);
	lines.push(`contentSelector: ${debug.contentSelector || '(none)'}`);
	lines.push(`removals: ${debug.removals.length}`);
	for (const r of debug.removals) {
		lines.push(formatRemoval(r));
	}
	return lines.join('\n') + '\n';
}

function formatRemoval(r: DebugRemoval): string {
	const parts: string[] = [];
	parts.push(`[${r.step}]`);
	if (r.reason) parts.push(r.reason);
	if (r.selector) parts.push(`(${r.selector})`);
	// `text` is a short preview from the source; keep it on one line.
	const preview = r.text.replace(/\s+/g, ' ').trim();
	parts.push(`— ${preview}`);
	return parts.join(' ');
}

export function createProgram(): Command {
	const program = new Command();

	program
		.name('defuddle')
		.description('Extract article content from web pages')
		.version(version);

	program
		.command('parse')
		.description('Parse HTML content from a file, URL, or stdin')
		.argument('[source]', 'HTML file path, URL, or "-" to read from stdin')
		.option('-o, --output <file>', 'Output file path (default: stdout)')
		.option('-m, --markdown', 'Convert content to markdown format')
		.option('--md', 'Alias for --markdown')
		.option('-j, --json', 'Output as JSON with metadata and content')
		.option('-f, --frontmatter', 'Prepend YAML frontmatter (title, author, source, etc.) to the output')
		.option('-p, --property <name>', 'Extract a specific property (e.g., title, description, domain)')
		.option('--debug', 'Enable debug mode')
		.option('-l, --lang <code>', 'Preferred language (BCP 47, e.g. en, fr, ja)')
		.option('-u, --user-agent <string>', 'Custom User-Agent header for HTTP requests (helps with 403/FORBIDDEN responses)')
		.option('--source-url <url>', 'URL the input HTML originated from (enables site-specific extractors when source is stdin or a local file)')
		.option('--extractor <path>', 'Load a custom extractor module (repeatable). The file must default-export { patterns, extractor }.', collectExtractor, [])
		.action(async (source: string | undefined, options: ParseOptions) => {
			try {
				const { output, debugLog } = await parseSource(source, options);

				// Handle output
				if (options.output) {
					const outputPath = resolve(process.cwd(), options.output);
					await writeFile(outputPath, output, 'utf-8');
					console.log(ansi.green(`Output written to ${options.output}`));
				} else {
					console.log(output);
				}

				// In --debug mode without --json, surface the removal log on
				// stderr so it does not interleave with the primary output.
				if (debugLog) {
					process.stderr.write(debugLog);
				}
			} catch (error) {
				console.error(ansi.red('Error:'), error instanceof Error ? error.message : 'Unknown error occurred');
				process.exit(1);
			}
		});

	return program;
}

const program = createProgram();

if (require.main === module) {
	program.parse();
}
