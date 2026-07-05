const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const DEFAULT_CHAR_WHITELIST = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_AMBIGUOUS_MAP = {
  o: '0',
  i: '1',
  l: '1',
  '|': '1',
  z: '2',
  s: '5',
  b: '6',
  g: '9',
};

function normalizeCaptchaText(text, length = 4, ambiguousMap = DEFAULT_AMBIGUOUS_MAP) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '');

  const strict = raw
    .replace(/[^a-z0-9]/g, '')
    .slice(0, length);

  if (strict.length === length) {
    return strict;
  }

  const corrected = Array.from(raw)
    .map(char => ambiguousMap[char] || char)
    .join('');

  return corrected
    .replace(/[^a-z0-9]/g, '')
    .slice(0, length);
}

function getLocalTesseractOptions(lang, options = {}) {
  const workerOptions = {
    cachePath: options.cachePath || process.cwd(),
    ...options.workerOptions,
  };

  if (options.langPath) {
    workerOptions.langPath = options.langPath;
    if (options.gzip !== undefined) workerOptions.gzip = options.gzip;
    return workerOptions;
  }

  const localTrainedData = path.resolve(process.cwd(), `${lang}.traineddata`);
  if (fs.existsSync(localTrainedData)) {
    workerOptions.langPath = path.dirname(localTrainedData);
    workerOptions.gzip = false;
  }

  return workerOptions;
}

async function toImageBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return fs.promises.readFile(input);
}

async function buildImageVariants(input, options = {}) {
  const source = await toImageBuffer(input);
  const scale = options.scale || 6;
  const threshold = options.threshold || 165;

  const base = sharp(source).resize({ width: 80 * scale, withoutEnlargement: false }).grayscale();
  const variants = [
    { name: 'original', input: source },
    { name: 'gray-scale', input: await base.clone().normalize().png().toBuffer() },
    { name: 'threshold', input: await base.clone().normalize().threshold(threshold).png().toBuffer() },
    { name: 'threshold-negate', input: await base.clone().normalize().threshold(threshold).negate().png().toBuffer() },
  ];

  if (options.debugDir) {
    await fs.promises.mkdir(options.debugDir, { recursive: true });
    for (const variant of variants) {
      await fs.promises.writeFile(path.join(options.debugDir, `captcha_${variant.name}.png`), variant.input);
    }
  }

  return variants;
}

async function recognizeCaptcha(input, options = {}) {
  const {
    lang = 'eng',
    expectedLength = 4,
    charWhitelist = DEFAULT_CHAR_WHITELIST,
    ambiguousMap = DEFAULT_AMBIGUOUS_MAP,
    minConfidence = 0,
    variants = true,
    verbose = false,
  } = options;

  const workerOptions = getLocalTesseractOptions(lang, options);
  if (verbose) {
    workerOptions.logger = (message) => console.log('[OCR]', message);
  }

  const worker = await createWorker(lang, 1, workerOptions, {
    load_system_dawg: '0',
    load_freq_dawg: '0',
    load_number_dawg: '0',
    load_punc_dawg: '0',
  });

  try {
    await worker.setParameters({
      tessedit_char_whitelist: charWhitelist,
      tessedit_pageseg_mode: '7',
      classify_bln_numeric_mode: '0',
      user_defined_dpi: '300',
    });

    const imageVariants = variants ? await buildImageVariants(input, options) : [{ name: 'original', input }];
    const results = [];

    for (const variant of imageVariants) {
      const result = await worker.recognize(variant.input);
      const rawText = result.data.text || '';
      const text = normalizeCaptchaText(rawText, expectedLength, ambiguousMap);
      const valid = new RegExp(`^[a-z0-9]{${expectedLength}}$`).test(text);
      results.push({
        variant: variant.name,
        text,
        rawText,
        confidence: result.data.confidence,
        minConfidence,
        valid,
      });
    }

    results.sort((a, b) => {
      if (a.valid !== b.valid) return a.valid ? -1 : 1;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    return {
      ...results[0],
      candidates: results,
    };
  } finally {
    await worker.terminate();
  }
}

module.exports = {
  DEFAULT_AMBIGUOUS_MAP,
  DEFAULT_CHAR_WHITELIST,
  buildImageVariants,
  getLocalTesseractOptions,
  normalizeCaptchaText,
  recognizeCaptcha,
};

if (require.main === module) {
  (async () => {
    const imagePath = process.argv[2] || './captcha.png';
    const result = await recognizeCaptcha(imagePath, { verbose: process.argv.includes('--verbose') });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  })().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
