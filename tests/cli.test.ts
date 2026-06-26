import { describe, expect, test } from 'vitest';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { Defuddle } from '../src/node';
import { parseSource, createProgram } from '../src/cli';
import { parseDocument } from './helpers';

const fixturePath = join(__dirname, 'fixtures', 'general--appendix-heading.html');
const fixtureHtml = readFileSync(fixturePath, 'utf-8');

function createMockStdin(html: string, isTTY = false): NodeJS.ReadStream {
	const stdin = Readable.from([html], { encoding: 'utf8' }) as NodeJS.ReadStream;
	(stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = isTTY;
	return stdin;
}

async function getExpectedContent(html: string): Promise<string> {
	const doc = parseDocument(html);
	const result = await Defuddle(doc);
	return result.content;
}

function stripHtmlAndNormalizeWhitespace(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

describe('CLI parseSource', () => {
	test('reads HTML from stdin when no source is provided', async () => {
		const expected = await getExpectedContent(fixtureHtml);

		const result = await parseSource(undefined, {}, createMockStdin(fixtureHtml));

		expect(stripHtmlAndNormalizeWhitespace(result.output)).toEqual(stripHtmlAndNormalizeWhitespace(expected));
	});

	test('reads HTML from stdin when source is "-"', async () => {
		const result = await parseSource('-', { json: true }, createMockStdin(fixtureHtml));
		const parsed = JSON.parse(result.output);

		expect(parsed.title).toBe('Article with Appendix');
		expect(parsed.content).toContain('Appendix I');
	});

	test('continues to read local HTML files', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'defuddle-cli-'));
		const filePath = join(tempDir, 'page.html');
		try {
			writeFileSync(filePath, fixtureHtml, 'utf-8');

			const expected = await getExpectedContent(fixtureHtml);
			const result = await parseSource(filePath, {});

			expect(stripHtmlAndNormalizeWhitespace(result.output)).toEqual(stripHtmlAndNormalizeWhitespace(expected));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('throws a helpful error when no source is provided and stdin is a TTY', async () => {
		const stdin = createMockStdin('', true);

		await expect(parseSource(undefined, {}, stdin)).rejects.toThrow(
			'No input source provided. Pass a file path or URL, or pipe HTML to stdin.'
		);
	});

	test('prepends YAML frontmatter when --frontmatter is set', async () => {
		const body = await getExpectedContent(fixtureHtml);

		const result = await parseSource(undefined, { frontmatter: true }, createMockStdin(fixtureHtml));

		expect(result.output.startsWith('---\n')).toBe(true);
		expect(result.output).toContain('title: "Article with Appendix"');
		// frontmatter block closes with --- followed by a blank line, then the body
		expect(result.output).toContain('---\n\n' + body);
		// stdin input has no URL, so no source: line is emitted
		expect(result.output).not.toContain('source:');
	});

	test('omits frontmatter by default', async () => {
		const result = await parseSource(undefined, {}, createMockStdin(fixtureHtml));
		expect(result.output.startsWith('---')).toBe(false);
	});

	test('registers the --frontmatter flag with a -f alias', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const option = parseCommand?.options.find((o) => o.long === '--frontmatter');

		expect(option).toBeDefined();
		expect(option?.short).toBe('-f');
		expect(option?.attributeName()).toBe('frontmatter');
	});

	test('registers the --user-agent flag with a -u alias', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const option = parseCommand?.options.find((o) => o.long === '--user-agent');

		expect(option).toBeDefined();
		expect(option?.short).toBe('-u');
		// commander camelCases --user-agent → options.userAgent, which parseSource reads.
		expect(option?.attributeName()).toBe('userAgent');
	});

	test('registers the --source-url flag', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const option = parseCommand?.options.find((o) => o.long === '--source-url');

		expect(option).toBeDefined();
		// commander camelCases --source-url → options.sourceUrl, which parseSource reads.
		expect(option?.attributeName()).toBe('sourceUrl');
	});

	test('uses --source-url to activate site-specific extractors for stdin input', async () => {
		// The Claude conversation fixture has data-testid="user-message" and
		// .font-claude-response divs, which the ClaudeExtractor recognises and
		// formats with **You** / **Claude** author labels — but only when a
		// claude.ai URL is supplied as the document URL. Without a URL, the
		// extractor registry has no domain match, generic scoring runs, and
		// the author labels are absent from the output.
		const claudeFixture = readFileSync(
			join(__dirname, 'fixtures', 'extractor--claude-conversation.html'),
			'utf-8'
		);

		// Baseline: without --source-url, ClaudeExtractor does not run, so the
		// "**You**" / "**Claude**" author labels (only the conversation
		// extractor emits these) are missing from the output.
		const baseline = await parseSource(
			'-',
			{ markdown: true },
			createMockStdin(claudeFixture)
		);
		expect(baseline.output).not.toContain('**You**');
		expect(baseline.output).not.toContain('**Claude**');

		// With --source-url pointing at claude.ai, ClaudeExtractor activates
		// and emits the structured conversation turns with author labels.
		const result = await parseSource(
			'-',
			{ markdown: true, sourceUrl: 'https://claude.ai/chat/example-fixture' },
			createMockStdin(claudeFixture)
		);
		expect(result.output).toContain('**You**');
		expect(result.output).toContain('**Claude**');
		expect(result.output).toContain('Paris');
		expect(result.output).toContain('Berlin');
	});

	test('registers the --extractor flag as a repeatable string array', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const option = parseCommand?.options.find((o) => o.long === '--extractor');

		expect(option).toBeDefined();
		expect(option?.attributeName()).toBe('extractor');
		// commander invokes the collector with the default starting empty array
		expect(option?.defaultValue).toEqual([]);
	});

	test('--extractor loads the supplied module and registers it with ExtractorRegistry', async () => {
		const { ExtractorRegistry } = await import('../src/extractor-registry');
		const fixturePath = join(__dirname, 'fixtures', 'cli-extractor-custom.mjs');

		const before = (ExtractorRegistry as unknown as { mappings: unknown[] }).mappings.length;

		// parseSource runs loadExtractor early. The fixture's patterns don't match
		// the stdin (no URL) so the registered extractor isn't used for parsing —
		// we only assert registration happened.
		await parseSource(undefined, { extractor: [fixturePath] }, createMockStdin(fixtureHtml));

		const after = (ExtractorRegistry as unknown as { mappings: unknown[] }).mappings.length;
		expect(after).toBe(before + 1);
	});

	test('--extractor rejects modules that do not default-export the expected shape', async () => {
		const fixturePath = join(__dirname, 'fixtures', 'cli-extractor-malformed.mjs');

		await expect(
			parseSource(undefined, { extractor: [fixturePath] }, createMockStdin(fixtureHtml))
		).rejects.toThrow(/must default-export/);
	});

	test('--debug --json embeds the debug payload alongside other fields', async () => {
		const result = await parseSource('-', { json: true, debug: true }, createMockStdin(fixtureHtml));
		const parsed = JSON.parse(result.output);

		// Existing fields stay; new `debug` field is now present.
		expect(parsed.title).toBeDefined();
		expect(parsed.debug).toBeDefined();
		expect(typeof parsed.debug.contentSelector).toBe('string');
		expect(Array.isArray(parsed.debug.removals)).toBe(true);
		// debugLog is reserved for the non-JSON path; --json should not emit it.
		expect(result.debugLog).toBeUndefined();
	});

	test('--debug without --json returns a human-readable debugLog for stderr', async () => {
		const result = await parseSource('-', { debug: true }, createMockStdin(fixtureHtml));

		expect(typeof result.debugLog).toBe('string');
		expect(result.debugLog).toContain('# defuddle --debug');
		expect(result.debugLog).toContain('contentSelector:');
		expect(result.debugLog).toContain('removals:');
		// Primary output remains the content body (stdout-safe — the debug
		// log goes via the returned `debugLog` to be written to stderr).
		expect(result.output).not.toContain('# defuddle --debug');
	});

	test('omits debug payload entirely when --debug is not set', async () => {
		const jsonResult = await parseSource('-', { json: true }, createMockStdin(fixtureHtml));
		const parsed = JSON.parse(jsonResult.output);
		expect(parsed.debug).toBeUndefined();

		const plain = await parseSource('-', {}, createMockStdin(fixtureHtml));
		expect(plain.debugLog).toBeUndefined();
	});

	test('registers each removal toggle flag', () => {
		const parseCommand = createProgram().commands.find((c) => c.name() === 'parse');
		const flags = [
			'--no-content-patterns',
			'--no-low-scoring',
			'--no-exact-selectors',
			'--no-partial-selectors',
			'--no-hidden-elements',
			'--no-small-images',
			'--remove-images',
		];
		for (const long of flags) {
			const option = parseCommand?.options.find((o) => o.long === long);
			expect(option, `option ${long} is registered`).toBeDefined();
		}
	});

	test('--no-content-patterns keeps content otherwise stripped by the metadata-list heuristic', async () => {
		// The blog-metadata-list heuristic removes short trailing <ul> link
		// lists introduced by a sentence not ending in ':'. Use a minimal
		// fixture that triggers it: an article ending with such a list.
		const html = `<!DOCTYPE html><html><body><main><article>
			<h1>Test article</h1>
			<p>The body has enough words to make the article extract well and clear the very-short content threshold so the rest of the pipeline runs as it would on a real article. We add a second sentence to make sure the scoring pass keeps this element.</p>
			<p>The companion artifacts are available from the following sources.</p>
			<ul>
				<li><a href="https://example.com/a">Mirror A</a></li>
				<li><a href="https://example.com/b">Mirror B</a></li>
			</ul>
		</article></main></body></html>`;

		const defaultResult = await parseSource('-', {}, createMockStdin(html));
		const keptResult = await parseSource(
			'-',
			{ contentPatterns: false },
			createMockStdin(html),
		);

		// With the default pipeline, the trailing link list is the kind of
		// element the metadata-list heuristic strips. Disabling content
		// patterns must keep it.
		expect(defaultResult.output).not.toContain('Mirror A');
		expect(keptResult.output).toContain('Mirror A');
		expect(keptResult.output).toContain('Mirror B');
	});

	test('--remove-images strips images from the output', async () => {
		const html = `<!DOCTYPE html><html><body><main><article>
			<h1>Test article</h1>
			<p>Article body with enough text content to clear the scoring pass and the very-short threshold so the rest of the pipeline runs normally during extraction.</p>
			<p><img src="https://example.com/cover.png" alt="cover" width="800" height="600"></p>
			<p>More body content follows the image to keep it inline within the article scope.</p>
		</article></main></body></html>`;

		const withImages = await parseSource('-', {}, createMockStdin(html));
		const withoutImages = await parseSource('-', { removeImages: true }, createMockStdin(html));

		expect(withImages.output).toContain('cover.png');
		expect(withoutImages.output).not.toContain('cover.png');
	});
});
