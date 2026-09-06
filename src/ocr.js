// Extraction automatique du montant total d'un ticket de caisse / facture, via Tesseract.js
// (OCR libre, open source, exécuté entièrement dans le navigateur — aucun service tiers,
// aucune clé, aucun coût). Le résultat n'est qu'une aide au remplissage : le champ reste
// toujours modifiable, l'OCR se trompe parfois sur des tickets froissés ou peu lisibles.
import { createWorker } from 'tesseract.js';

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('fra');
  }
  return workerPromise;
}

// Mots-clés qui précèdent en général le montant final sur un ticket français, du plus au
// moins fiable (un ticket a souvent plusieurs montants : sous-total, TVA, rendu monnaie...).
const TOTAL_KEYWORDS = ['net à payer', 'net a payer', 'total ttc', 'à payer', 'a payer', 'total', 'ttc', 'montant'];

// Repère un nombre au format monétaire français (12,50 / 1 234,56 / 12.50) et le convertit
// en centimes.
const AMOUNT_RE = /\d{1,3}(?:[ .]\d{3})*[,.]\d{2}/g;

function parseAmountToCents(str) {
  const normalized = str.replace(/\s/g, '').replace(/\.(?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function parseTotalFromText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const keyword of TOTAL_KEYWORDS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const lower = lines[i].toLowerCase();
      if (!lower.includes(keyword)) continue;
      const matches = lines[i].match(AMOUNT_RE);
      if (matches?.length) return parseAmountToCents(matches[matches.length - 1]);
      // Le montant est parfois sur la ligne suivante plutôt que sur celle du mot-clé.
      const nextMatches = lines[i + 1]?.match(AMOUNT_RE);
      if (nextMatches?.length) return parseAmountToCents(nextMatches[0]);
    }
  }

  // Aucun mot-clé trouvé : à défaut, le plus gros montant détecté sur le ticket est
  // généralement le total (plus grand que chaque ligne d'article prise isolément).
  const all = text.match(AMOUNT_RE);
  if (!all?.length) return null;
  const amounts = all.map(parseAmountToCents).filter((c) => c != null);
  return amounts.length ? Math.max(...amounts) : null;
}

// `source` : URL, File/Blob, ou tout ce qu'accepte Tesseract.js.
export async function extractTotalFromImage(source) {
  const worker = await getWorker();
  const { data: { text } } = await worker.recognize(source);
  return parseTotalFromText(text);
}
