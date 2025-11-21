#!/usr/bin/env node
/**
 * Enrich an existing cards JSON file with:
 *  - tokenized word breakdowns (lemma, reading, glosses)
 *  - sentence-level translations (from hints or literal fallback)
 *  - refreshed TSV output compatible with Anki
 *
 * Usage:
 *   node scripts/enrichCards.mjs path/to/cards.json [options]
 *
 * Options:
 *   --dict <file>          Path to a dictionary JSON (defaults to data/japanese-mini-dict.json)
 *   --translations <file>  Optional JSON file with translations keyed by id or sentence
 *   --out <file>           Custom path for the enriched card JSON (defaults to input path)
 *   --tsv <file>           Custom path for the TSV output (defaults to alongside JSON)
 *   --no-tsv               Skip writing the TSV file
 *   -h, --help             Show usage help
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kuromoji from 'kuromoji';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  printUsage();
  process.exit(args.length ? 0 : 1);
}

try {
  const options = parseOptions(args);

  const tokenizer = await buildTokenizer();
  const dictionary = loadDictionary(options.dictPath);
  const translations = loadTranslationHints(options.translationPath);

  const rawCards = JSON.parse(readFileSync(options.inputPath, 'utf8'));
  const enrichedCards = rawCards.map((card) => enrichCard(card, tokenizer, dictionary, translations));

  writeFileSync(options.outputJsonPath, JSON.stringify(enrichedCards, null, 2), 'utf8');
  console.log(`Enriched JSON written to ${options.outputJsonPath}`);

  if (options.writeTsv) {
    writeFileSync(options.tsvPath, cardsToTsv(enrichedCards), 'utf8');
    console.log(`TSV output written to ${options.tsvPath}`);
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

/**
 * @param {ReturnType<kuromoji.Builder["build"]>} tokenizer
 */
function enrichCard(card, tokenizer, dictionary, translations) {
  const tokens = tokenizer.tokenize(card.sentence || '');
  const breakdown = tokens
    .map((token) => normalizeToken(token, dictionary))
    .filter((token) => token.surface.trim().length);

  const translation =
    pickTranslation(card, translations) ??
    (card.translation && card.translation.trim().length ? card.translation : null) ??
    buildLiteralTranslation(breakdown);

  return {
    ...card,
    translation: translation ?? '',
    tokens: breakdown,
  };
}

function normalizeToken(token, dictionary) {
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

function buildPosLabel(token) {
  return [token.pos, token.pos_detail_1, token.pos_detail_2, token.pos_detail_3]
    .filter((part) => part && part !== '*')
    .join('-');
}

function buildLiteralTranslation(tokens) {
  if (!tokens.length) return '';
  return tokens
    .map((token) => (token.meanings?.[0] ? token.meanings[0] : token.surface))
    .join(' ');
}

function pickTranslation(card, translations) {
  if (translations.byId.has(String(card.id))) {
    return translations.byId.get(String(card.id));
  }

  if (card.subtitleId && translations.byId.has(String(card.subtitleId))) {
    return translations.byId.get(String(card.subtitleId));
  }

  const normalizedSentence = (card.sentence || '').trim();
  if (normalizedSentence.length && translations.bySentence.has(normalizedSentence)) {
    return translations.bySentence.get(normalizedSentence);
  }

  return null;
}

async function buildTokenizer() {
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

function loadDictionary(dictPath) {
  if (!existsSync(dictPath)) {
    console.warn(`Dictionary file not found at ${dictPath}. Meanings will be omitted.`);
    return new Map();
  }

  const payload = JSON.parse(readFileSync(dictPath, 'utf8'));
  const entries = Array.isArray(payload) ? payload : [];

  return new Map(entries.map((entry) => [entry.lemma, entry]));
}

function loadTranslationHints(path) {
  if (!path) {
    return { byId: new Map(), bySentence: new Map() };
  }

  if (!existsSync(path)) {
    console.warn(`Translation hint file not found at ${path}. Skipping translations.`);
    return { byId: new Map(), bySentence: new Map() };
  }

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const byId = new Map();
  const bySentence = new Map();

  const registerEntry = (entry) => {
    if (!entry) return;
    if (entry.id != null && entry.translation) {
      byId.set(String(entry.id), entry.translation);
    }
    if (entry.sentence && entry.translation) {
      bySentence.set(entry.sentence.trim(), entry.translation);
    }
  };

  if (Array.isArray(raw)) {
    raw.forEach(registerEntry);
  } else if (typeof raw === 'object' && raw !== null) {
    Object.entries(raw).forEach(([key, value]) => {
      if (typeof value === 'string') {
        byId.set(key, value);
      } else if (value && typeof value === 'object') {
        registerEntry({ id: key, ...value });
      }
    });
  }

  return { byId, bySentence };
}

function katakanaToHiragana(text) {
  return text.replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

function parseOptions(cliArgs) {
  const opts = {
    inputPath: null,
    dictPath: resolveDefaultDict(),
    translationPath: null,
    outputJsonPath: null,
    tsvPath: null,
    writeTsv: true,
  };

  opts.inputPath = resolve(cliArgs[0]);

  for (let i = 1; i < cliArgs.length; i += 1) {
    const token = cliArgs[i];
    switch (token) {
      case '--dict':
        opts.dictPath = ensureNext(cliArgs, ++i, '--dict');
        break;
      case '--translations':
        opts.translationPath = ensureNext(cliArgs, ++i, '--translations');
        break;
      case '--out':
        opts.outputJsonPath = ensureNext(cliArgs, ++i, '--out');
        break;
      case '--tsv':
        opts.tsvPath = ensureNext(cliArgs, ++i, '--tsv');
        break;
      case '--no-tsv':
        opts.writeTsv = false;
        break;
      default:
        throw new Error(`Unknown option "${token}". Use --help for usage.`);
    }
  }

  opts.outputJsonPath = resolve(
    opts.outputJsonPath ?? opts.inputPath,
  );

  if (opts.writeTsv) {
    const guessedTsv = replaceExt(opts.outputJsonPath, '.tsv');
    opts.tsvPath = resolve(opts.tsvPath ?? guessedTsv);
  }

  return opts;
}

function ensureNext(tokens, index, optionName) {
  if (index >= tokens.length) {
    throw new Error(`${optionName} requires a file path argument.`);
  }
  return resolve(tokens[index]);
}

function replaceExt(filePath, newExt) {
  const dir = dirname(filePath);
  const base = basename(filePath, extname(filePath));
  return resolve(dir, `${base}${newExt}`);
}

function resolveDefaultDict() {
  return resolve(__dirname, '../data/japanese-mini-dict.json');
}

function cardsToTsv(cards) {
  return cards.map((card) => `${clean(card.sentence)}\t${clean(card.translation)}`).join('\n');
}

function clean(value) {
  return (value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

function printUsage() {
  console.log(`Usage: node scripts/enrichCards.mjs <cards.json> [options]

Options:
  --dict <path>          Custom dictionary JSON
  --translations <path>  JSON with translations keyed by id or sentence
  --out <path>           Destination for enriched JSON (defaults to input)
  --tsv <path>           Destination for TSV (defaults to alongside JSON)
  --no-tsv               Skip writing the TSV output
  -h, --help             Show this help text
`);
}

