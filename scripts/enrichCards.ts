#!/usr/bin/env node
/**
 * Enrich an existing cards JSON file with:
 *  - tokenized word breakdowns (lemma, reading, glosses)
 *  - sentence-level translations (from hints or literal fallback)
 *  - refreshed TSV output compatible with Anki
 *
 * Usage:
 *   npx tsx scripts/enrichCards.ts path/to/cards.json [options]
 *
 * Options:
 *   --dict <file>          Path to a dictionary JSON (defaults to data/japanese-mini-dict.json)
 *   --translations <file>  Optional JSON file with translations keyed by id or sentence
 *   --out <file>           Custom path for the enriched card JSON (defaults to input path)
 *   --tsv <file>           Custom path for the TSV output (defaults to alongside JSON)
 *   --no-tsv               Skip writing the TSV file
 *   --auto-translate       Use DeepL API to fill missing translations
 *   --deepl-translate      Alias for --auto-translate
 *   --auto-translate-keep  Keep existing card translations (don’t overwrite literals)
 *   --deepl-formality <v>  DeepL formality (default, more, less, prefer_more, prefer_less)
 *   --deepl-glossary <id>  DeepL glossary ID to apply
 *   -h, --help             Show usage help
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kuromoji from 'kuromoji';
import type { IpadicFeatures, Tokenizer } from 'kuromoji';
import { Translator as DeepLTranslator } from 'deepl-node';

type KuromojiTokenizer = Tokenizer<IpadicFeatures>;

interface DictionaryEntry {
  lemma: string;
  reading?: string;
  pos?: string;
  meanings?: string[];
}

interface TokenBreakdown {
  surface: string;
  lemma: string;
  reading: string | null;
  pos: string;
  meanings: string[] | null;
}

interface CardRecord {
  id: number;
  subtitleId?: number | null;
  sentence?: string | null;
  translation?: string | null;
  romaji?: string;
  furigana?: string;
  startTime?: string | null;
  endTime?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  tokens?: TokenBreakdown[];
  [key: string]: unknown;
}

interface TranslationEntry {
  id: number | string | null;
  subtitleId: number | string | null;
  sentence: string | null;
  translation: string;
}

interface TranslationState {
  byId: Map<string, string>;
  bySubtitleId: Map<string, string>;
  bySentence: Map<string, string>;
  addedEntries: TranslationEntry[];
  initialEntries: TranslationEntry[];
  sourcePath: string | null;
}

interface CliOptions {
  inputPath: string;
  dictPath: string;
  translationPath: string | null;
  translationSavePath: string | null;
  outputJsonPath: string;
  tsvPath: string;
  writeTsv: boolean;
  autoTranslate: boolean;
  autoTranslateReplace: boolean;
  deeplFormality: string;
  deeplGlossaryId: string | null;
}

type TranslatorFn = (card: CardRecord) => Promise<string | null>;

const POS_MAP: Record<string, string> = {
  名詞: 'noun',
  動詞: 'verb',
  形容詞: 'adjective',
  副詞: 'adverb',
  助詞: 'particle',
  助動詞: 'auxiliary-verb',
  記号: 'symbol',
  連体詞: 'prenoun-adjectival',
  感動詞: 'interjection',
  接続詞: 'conjunction',
  接頭詞: 'prefix',
  その他: 'other',
  フィラー: 'filler',
  一般: 'general',
  固有名詞: 'proper-noun',
  サ変接続: 'suru-verb',
  自立: 'independent',
  非自立: 'non-independent',
  形容動詞語幹: 'na-adj-stem',
  数: 'number',
  助数詞: 'counter',
  係助詞: 'binding-particle',
  格助詞: 'case-particle',
  副助詞: 'adverbial-particle',
  並立助詞: 'parallel-particle',
  終助詞: 'sentence-ending-particle',
  連体化: 'attributive',
  接続助詞: 'conjunctive-particle',
  感動詞語幹: 'interjection-stem',
  括弧開: 'open-bracket',
  括弧閉: 'close-bracket',
  句点: 'period',
  読点: 'comma',
  空白: 'whitespace',
  記号一般: 'symbol-general',
  代名詞: 'pronoun',
  副詞可能: 'adverbial',
  連語: 'expression',
  語幹: 'stem',
  テ形: 'te-form',
  タ形: 'ta-form',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(args.length ? 0 : 1);
  }

  const options = parseOptions(args);

  const tokenizer = await buildTokenizer();
  const dictionary = loadDictionary(options.dictPath);
  const translations = loadTranslationHints(options.translationPath);
  const translator: TranslatorFn | null = options.autoTranslate
    ? createDeepLTranslator({
        formality: options.deeplFormality,
        glossaryId: options.deeplGlossaryId,
      })
    : null;

  const rawCards: CardRecord[] = JSON.parse(readFileSync(options.inputPath, 'utf8'));
  const enrichedCards: CardRecord[] = [];

  for (const card of rawCards) {
    // eslint-disable-next-line no-await-in-loop
    const enriched = await enrichCard(
      card,
      tokenizer,
      dictionary,
      translations,
      translator,
      {
        autoTranslateReplace: options.autoTranslateReplace,
      },
    );
    enrichedCards.push(enriched);
  }

  writeFileSync(options.outputJsonPath, JSON.stringify(enrichedCards, null, 2), 'utf8');
  console.log(`Enriched JSON written to ${options.outputJsonPath}`);

  if (options.writeTsv) {
    writeFileSync(options.tsvPath, cardsToTsv(enrichedCards), 'utf8');
    console.log(`TSV output written to ${options.tsvPath}`);
  }

  if (options.translationSavePath && translations.addedEntries.length) {
    persistTranslations(translations, options.translationSavePath);
  }
}

async function enrichCard(
  card: CardRecord,
  tokenizer: KuromojiTokenizer,
  dictionary: Map<string, DictionaryEntry>,
  translations: TranslationState,
  translator: TranslatorFn | null,
  options: { autoTranslateReplace: boolean },
): Promise<CardRecord> {
  const tokens = tokenizer.tokenize(card.sentence || '');
  const breakdown = tokens
    .map((token) => normalizeToken(token, dictionary))
    .filter((token) => token.surface.trim().length);

  const translatorEnabled = Boolean(translator);
  const cardTranslation = (card.translation || '').trim();

  let translationSource: 'hint' | 'card' | 'literal' | 'deepl' | null = null;
  let translation = pickTranslation(card, translations);
  if (translation) {
    translationSource = 'hint';
  }

  if (!translation && cardTranslation.length && (!translatorEnabled || !options.autoTranslateReplace)) {
    translation = cardTranslation;
    translationSource = 'card';
  }

  if (!translation) {
    translation = buildLiteralTranslation(breakdown);
    translationSource = 'literal';
  }

  const shouldAutoTranslate =
    translatorEnabled &&
    (!translation || (options.autoTranslateReplace && translationSource !== 'hint'));

  if (shouldAutoTranslate && translator) {
    const generated = await translator(card);
    if (generated) {
      translation = generated;
      translationSource = 'deepl';
      registerGeneratedTranslation(translations, card, translation);
    }
  }

  return {
    ...card,
    translation: translation ?? '',
    tokens: breakdown,
  };
}

function normalizeToken(token: IpadicFeatures, dictionary: Map<string, DictionaryEntry>): TokenBreakdown {
  const lemma = token.basic_form && token.basic_form !== '*' ? token.basic_form : token.surface_form;
  const dictEntry = dictionary.get(lemma);

  return {
    surface: token.surface_form,
    lemma,
    reading: token.reading && token.reading !== '*' ? katakanaToHiragana(token.reading) : null,
    pos: buildPosLabel(token),
    meanings: dictEntry?.meanings ?? null,
  };
}

function buildPosLabel(token: IpadicFeatures): string {
  return [token.pos, token.pos_detail_1, token.pos_detail_2, token.pos_detail_3]
    .map((part) => translatePosPart(part))
    .filter((part): part is string => Boolean(part))
    .join('-');
}

function translatePosPart(part?: string | null): string | null {
  if (!part || part === '*') return null;
  return part
    .split('／')
    .map((segment) => {
      const trimmed = segment.trim();
      return POS_MAP[trimmed] ?? trimmed;
    })
    .join('/');
}

function buildLiteralTranslation(tokens: TokenBreakdown[]): string {
  if (!tokens.length) return '';
  return tokens
    .map((token) => (token.meanings?.[0] ? token.meanings[0] : token.surface))
    .join(' ');
}

function pickTranslation(card: CardRecord, translations: TranslationState): string | null {
  if (translations.byId.has(String(card.id))) {
    return translations.byId.get(String(card.id)) ?? null;
  }

  if (card.subtitleId != null && translations.bySubtitleId.has(String(card.subtitleId))) {
    return translations.bySubtitleId.get(String(card.subtitleId)) ?? null;
  }

  const normalizedSentence = (card.sentence || '').trim();
  if (normalizedSentence.length && translations.bySentence.has(normalizedSentence)) {
    return translations.bySentence.get(normalizedSentence) ?? null;
  }

  return null;
}

function buildTokenizer(): Promise<KuromojiTokenizer> {
  const dictPath = resolve(__dirname, '../node_modules/kuromoji/dict');
  return new Promise((resolvePromise, rejectPromise) => {
    kuromoji.builder({ dicPath: dictPath }).build((err, tokenizer) => {
      if (err) {
        rejectPromise(err);
      } else {
        resolvePromise(tokenizer);
      }
    });
  });
}

function loadDictionary(dictPath: string): Map<string, DictionaryEntry> {
  if (!existsSync(dictPath)) {
    console.warn(`Dictionary file not found at ${dictPath}. Meanings will be omitted.`);
    return new Map();
  }

  const payload = JSON.parse(readFileSync(dictPath, 'utf8')) as DictionaryEntry[] | DictionaryEntry;
  const entries = Array.isArray(payload) ? payload : [payload];

  return new Map(entries.map((entry) => [entry.lemma, entry]));
}

function loadTranslationHints(path: string | null): TranslationState {
  const byId = new Map<string, string>();
  const bySubtitleId = new Map<string, string>();
  const bySentence = new Map<string, string>();
  const initialEntries: TranslationEntry[] = [];

  if (!path) {
    return { byId, bySubtitleId, bySentence, addedEntries: [], initialEntries, sourcePath: null };
  }

  if (!existsSync(path)) {
    console.warn(`Translation hint file not found at ${path}. Skipping translations.`);
    return { byId, bySubtitleId, bySentence, addedEntries: [], initialEntries, sourcePath: path };
  }

  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;

  const registerEntry = (entryLike: unknown): void => {
    const safeEntry = sanitizeTranslationEntry(entryLike);
    if (!safeEntry) return;
    if (safeEntry.id != null) {
      byId.set(String(safeEntry.id), safeEntry.translation);
    }
    if (safeEntry.subtitleId != null) {
      bySubtitleId.set(String(safeEntry.subtitleId), safeEntry.translation);
    }
    if (safeEntry.sentence) {
      bySentence.set(safeEntry.sentence, safeEntry.translation);
    }
    initialEntries.push(safeEntry);
  };

  if (Array.isArray(raw)) {
    raw.forEach(registerEntry);
  } else if (typeof raw === 'object' && raw !== null) {
    Object.entries(raw).forEach(([key, value]) => {
      if (typeof value === 'string') {
        registerEntry({ id: key, translation: value });
      } else if (value && typeof value === 'object') {
        registerEntry({ id: key, ...value });
      }
    });
  }

  return { byId, bySubtitleId, bySentence, addedEntries: [], initialEntries, sourcePath: path };
}

function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

function parseOptions(cliArgs: string[]): CliOptions {
  if (!cliArgs.length) {
    throw new Error('Input cards JSON is required.');
  }

  const opts: CliOptions = {
    inputPath: resolve(cliArgs[0]),
    dictPath: resolveDefaultDict(),
    translationPath: null,
    translationSavePath: null,
    outputJsonPath: '',
    tsvPath: '',
    writeTsv: true,
    autoTranslate: false,
    autoTranslateReplace: true,
    deeplFormality: 'default',
    deeplGlossaryId: null,
  };

  for (let i = 1; i < cliArgs.length; i += 1) {
    const token = cliArgs[i];
    switch (token) {
      case '--dict':
        opts.dictPath = resolve(ensureNext(cliArgs, ++i, '--dict'));
        break;
      case '--translations':
        opts.translationPath = resolve(ensureNext(cliArgs, ++i, '--translations'));
        break;
      case '--translations-out':
        opts.translationSavePath = resolve(ensureNext(cliArgs, ++i, '--translations-out'));
        break;
      case '--out':
        opts.outputJsonPath = resolve(ensureNext(cliArgs, ++i, '--out'));
        break;
      case '--tsv':
        opts.tsvPath = resolve(ensureNext(cliArgs, ++i, '--tsv'));
        break;
      case '--no-tsv':
        opts.writeTsv = false;
        break;
      case '--auto-translate':
      case '--deepl-translate':
        opts.autoTranslate = true;
        break;
      case '--auto-translate-keep':
        opts.autoTranslateReplace = false;
        break;
      case '--deepl-formality':
        opts.deeplFormality = ensureNext(cliArgs, ++i, '--deepl-formality');
        break;
      case '--deepl-glossary':
        opts.deeplGlossaryId = ensureNext(cliArgs, ++i, '--deepl-glossary');
        break;
      default:
        throw new Error(`Unknown option "${token}". Use --help for usage.`);
    }
  }

  opts.outputJsonPath = resolve(opts.outputJsonPath || opts.inputPath);

  if (opts.writeTsv) {
    const guessedTsv = replaceExt(opts.outputJsonPath, '.tsv');
    opts.tsvPath = resolve(opts.tsvPath || guessedTsv);
  } else {
    opts.tsvPath = opts.tsvPath ? resolve(opts.tsvPath) : opts.outputJsonPath.replace(/\.json$/, '.tsv');
  }

  if (!opts.translationSavePath && opts.translationPath) {
    opts.translationSavePath = opts.translationPath;
  }

  return opts;
}

function ensureNext(tokens: string[], index: number, optionName: string): string {
  if (index >= tokens.length) {
    throw new Error(`${optionName} requires a file path argument.`);
  }
  return tokens[index];
}

function replaceExt(filePath: string, newExt: string): string {
  const dir = dirname(filePath);
  const base = basename(filePath, extname(filePath));
  return resolve(dir, `${base}${newExt}`);
}

function resolveDefaultDict(): string {
  return resolve(__dirname, '../data/japanese-mini-dict.json');
}

function cardsToTsv(cards: CardRecord[]): string {
  return cards
    .map((card) => `${clean(card.sentence)}\t${clean(card.translation as string | null | undefined)}`)
    .join('\n');
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

function printUsage(): void {
  console.log(`Usage: npx tsx scripts/enrichCards.ts <cards.json> [options]

Options:
  --dict <path>          Custom dictionary JSON
  --translations <path>  JSON with translations keyed by id/subtitleId/sentence
  --translations-out <path>
                         Write updated translation cache (defaults to --translations path)
  --out <path>           Destination for enriched JSON (defaults to input)
  --tsv <path>           Destination for TSV (defaults to alongside JSON)
  --no-tsv               Skip writing the TSV output
  --auto-translate       Use DeepL API to fill missing translations
  --deepl-translate      Alias for --auto-translate
  --auto-translate-keep  Keep existing card translations (don’t overwrite literals)
  --deepl-formality <v>  DeepL formality (default, more, less, prefer_more, prefer_less)
  --deepl-glossary <id>  DeepL glossary ID to apply
  -h, --help             Show this help text
`);
}

function sanitizeTranslationEntry(entry: unknown): TranslationEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const maybe = entry as Record<string, unknown>;
  if (typeof maybe.translation !== 'string') return null;
  const translation = maybe.translation.trim();
  if (!translation.length) return null;

  const sentence =
    typeof maybe.sentence === 'string' && maybe.sentence.trim().length
      ? maybe.sentence.trim()
      : null;

  const normalizedId =
    maybe.id === null || maybe.id === undefined || maybe.id === ''
      ? null
      : normalizeNumeric(maybe.id);

  const normalizedSubtitleId =
    maybe.subtitleId === null || maybe.subtitleId === undefined || maybe.subtitleId === ''
      ? null
      : normalizeNumeric(maybe.subtitleId);

  return {
    id: normalizedId,
    subtitleId: normalizedSubtitleId,
    sentence,
    translation,
  };
}

function normalizeNumeric(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? String(value) : parsed;
}

function registerGeneratedTranslation(
  translations: TranslationState,
  card: CardRecord,
  translation: string,
): void {
  const normalizedSentence = (card.sentence || '').trim() || null;

  if (card.id != null) {
    translations.byId.set(String(card.id), translation);
  }
  if (card.subtitleId != null) {
    translations.bySubtitleId.set(String(card.subtitleId), translation);
  }
  if (normalizedSentence) {
    translations.bySentence.set(normalizedSentence, translation);
  }

  const entry = sanitizeTranslationEntry({
    id: card.id ?? null,
    subtitleId: card.subtitleId ?? null,
    sentence: normalizedSentence,
    translation,
  });
  if (entry) {
    translations.addedEntries.push(entry);
  }
}

function persistTranslations(translations: TranslationState, outputPath: string): void {
  const existing = translations.initialEntries ?? [];
  const additions = translations.addedEntries ?? [];
  const merged = mergeTranslationEntries(existing, additions);
  writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf8');
  console.log(
    `Translation cache updated at ${outputPath} (+${additions.length} new entries).`,
  );
}

function mergeTranslationEntries(
  existing: TranslationEntry[],
  additions: TranslationEntry[],
): TranslationEntry[] {
  const map = new Map<string, TranslationEntry>();
  let anonCounter = 0;

  const put = (entry: TranslationEntry | null): void => {
    if (!entry) return;
    const key =
      entry.subtitleId != null
        ? `subtitleId:${entry.subtitleId}`
        : entry.id != null
          ? `id:${entry.id}`
          : entry.sentence
            ? `sentence:${entry.sentence}`
            : `anon:${anonCounter++}`;
    map.set(key, entry);
  };

  existing.forEach(put);
  additions.forEach(put);

  return Array.from(map.values());
}

function createDeepLTranslator(options: {
  formality?: string;
  glossaryId?: string | null;
}): TranslatorFn {
  const authKey = process.env.DEEPL_API_KEY;
  if (!authKey) {
    throw new Error('DEEPL_API_KEY environment variable is required for --deepl-translate.');
  }

  const translator = new DeepLTranslator(authKey);
  const requestedFormality = options.formality ?? 'default';
  const normalizedFormality = normalizeDeepLFormality(requestedFormality);
  const glossaryId = options.glossaryId ?? null;

  return async (card: CardRecord) => {
    const sentence = (card.sentence || '').trim();
    if (!sentence.length) return null;
    try {
      const response = await translator.translateText(sentence, 'ja', 'en-US', {
        formality: normalizedFormality === 'default' ? undefined : normalizedFormality,
        glossary: glossaryId ?? undefined,
      });
      if (Array.isArray(response)) {
        return response[0]?.text?.trim() ?? null;
      }
      return response?.text?.trim() ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `DeepL translation failed for subtitle ${card.subtitleId ?? card.id}: ${message}`,
      );
      return null;
    }
  };
}

function normalizeDeepLFormality(value: string): 'default' | 'more' | 'less' {
  switch (value) {
    case 'more':
    case 'less':
    case 'default':
      return value;
    case 'prefer_more':
      return 'more';
    case 'prefer_less':
      return 'less';
    default:
      return 'default';
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

