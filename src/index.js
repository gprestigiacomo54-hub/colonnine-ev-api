const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const PUN_CSV_URL =
  'https://githubusercontent.com' +
  '/ondata/rete_ricarica_veicoli_elettrici/main/data/rete_ricarica_veicoli_elettrici.csv';

const LISTINO_OPERATORI = [
  { keywords: ['tesla'], nomeUfficiale: 'Tesla Supercharger', ac: 0.55, dc: 0.65 },
  { keywords: ['electra'], nomeUfficiale: 'Electra', ac: 0.54, dc: 0.54 },
  { keywords: ['enel', 'enel x', 'enelx'], nomeUfficiale: 'Enel X Way', ac: 0.67, dc: 0.75 },
  { keywords: ['plenitude', 'be charge', 'becharge', 'eni'], nomeUfficiale: 'Plenitude + Be Charge', ac: 0.65, dc: 0.85 },
  { keywords: ['ewiva'], nomeUfficiale: 'Ewiva', ac: 0.75, dc: 0.80 },
  { keywords: ['a2a'], nomeUfficiale: 'A2A E-Moving', ac: 0.65, dc: 0.90 },
  { keywords: ['duferco'], nomeUfficiale: 'Duferco Energia', ac: 0.74, dc: 0.79 },
  { keywords: ['electrip'], nomeUfficiale: 'Electrip', ac: 0.75, dc: 0.80 },
  { keywords: ['ionity'], nomeUfficiale: 'Ionity', ac: 0.85, dc: 0.85 },
  { keywords: ['atlante'], nomeUfficiale: 'Atlante', ac: 0.69, dc: 0.85 },
  { keywords: ['free to x', 'freetox'], nomeUfficiale: 'Free To X', ac: 0.75, dc: 0.85 },
  { keywords: ['neogy'], nomeUfficiale: 'Neogy', ac: 0.65, dc: 0.82 },
  { keywords: ['hera'], nomeUfficiale: 'Hera Comm', ac: 0.66, dc: 0.84 },
  { keywords: ['iren'], nomeUfficiale: 'IrenGO', ac: 0.65, dc: 0.82 },
  { keywords: ['ace', 'acea'], nomeUfficiale: 'Acea Energia', ac: 0.65, dc: 0.83 },
  { keywords: ['repower'], nomeUfficiale: 'Repower', ac: 0.68, dc: 0.82 },
  { keywords: ['sorgenia'], nomeUfficiale: 'Sorgenia', ac: 0.66, dc: 0.80 },
];

let cacheColonnine = [];
let ultimeIntestazioni = [];
let ultimoAggiornamentoCache = 0;
const DURATA_CACHE_MS = 24 * 60 * 60 * 1000;

function scaricaTestoHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { family: 4, headers: { 'User-Agent': 'ColonnineEVItaliaApp/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(scaricaTestoHttps(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP status ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function calcolaDistanzaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function risolviTariffa(rawOperator, isFastDc) {
  const pulito = String(rawOperator || '').replace(/^["']|["']$/g, '').trim();
  const lower = pulito.toLowerCase();

  for (const op of LISTINO_OPERATORI) {
    if (op.keywords.some((kw) => lower.includes(kw))) {
      return {
        gestore: op.nomeUfficiale,
        prezzo: isFastDc ? op.dc : op.ac,
      };
    }
  }

  const valido = pulito && lower !== 'nd' && lower !== 'n/d' && lower !== 'null';
  return {
    gestore: valido ? pulito : 'Colonnina Pubblica EV',
    prezzo: isFastDc ? 0.74 : 0.62,
  };
}

function formattaPresa(rawPresa, potenzaKw) {
  const p = String(rawPresa || '').toLowerCase();
  if (p.includes('ccs') || p.includes('combo')) return 'CCS Combo 2';
  if (p.includes('chademo')) return 'CHAdeMO';
  if (p.includes('type 2') || p.includes('tipo 2') || p.includes('mennekes') || p.includes('t2')) {
    return 'Tipo 2';
  }
  if (p.includes('type 3') || p.includes('tipo 3') || p.includes('scame')) return 'Tipo 3A';
  if (p.includes('schuko')) return 'Schuko';

  return potenzaKw >= 43 ? 'CCS Combo 2' : 'Tipo 2';
}

function parseCsvLine(line, sep) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.at(i);
    if (ch === '"') {
      if (inQuotes && line.at(i + 1) === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}
async function caricaDatasetPun() {
  const ora = Date.now();
  if (cacheColonnine.length > 0 && ora - ultimoAggiornamentoCache < DURATA_CACHE_MS) {
    return cacheColonnine;
  }

  const csvText = await scaricaTestoHttps(PUN_CSV_URL);
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('Dataset PUN vuoto');
  }

  const headerLine = lines.at(0);
  const sep = headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
  const headers = parseCsvLine(headerLine, sep).map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_]/g, '')
  );
  ultimeIntestazioni = headers;

  const idxLat = headers.findIndex((h) => h === 'lat' || h === 'latitude' || h === 'latitudine' || h === 'y');
  const idxLon = headers.findIndex((h) => h === 'lon' || h === 'lng' || h === 'longitude' || h === 'longitudine' || h === 'x');
  const idxCpo = headers.findIndex(
    (h) =>
      h.includes('cpo') ||
      h.includes('gestore') ||
      h.includes('operatore') ||
      h.includes('ragione') ||
      h.includes('sociale') ||
      h.includes('titolare') ||
      h.includes('azienda') ||
      h.includes('societa') ||
      h.includes('owner') ||
      h.includes('brand') ||
      h.includes('network') ||
      h.includes('denominazione') ||
      h === 'nome'
  );
  const idxAddr = headers.findIndex((h) => h.includes('indirizzo') || h.includes('address') || h.includes('via') || h.includes('ubicazione'));
  const idxCity = headers.findIndex((h) => h.includes('comune') || h.includes('city') || h.includes('citta') || h.includes('localita'));
  const idxPower = headers.findIndex((h) => h.includes('potenza') || h.includes('power') || h.includes('kw'));
  const idxPresa = headers.findIndex((h) => h.includes('presa') || h.includes('connettore') || h.includes('connector') || h.includes('socket'));

  const parsed = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines.at(i), sep);
    const lat = parseFloat((cols.at(idxLat) || '').replace(',', '.'));
    const lon = parseFloat((cols.at(idxLon) || '').replace(',', '.'));
    if (isNaN(lat) || isNaN(lon) || lat < 35 || lat > 48 || lon < 6 || lon > 19) continue;

    const rawCpo = idxCpo >= 0 ? cols.at(idxCpo) : '';
    const rawAddr = idxAddr >= 0 ? cols.at(idxAddr) : '';
    const rawCity = idxCity >= 0 ? cols.at(idxCity) : '';
    const rawPower = idxPower >= 0 ? cols.at(idxPower) : '';
    const rawPresa = idxPresa >= 0 ? cols.at(idxPresa) : '';

    let potenzaKw = 22;
    const matchKw = String(rawPower).match(/(\d+(?:[.,]\d+)?)/);
    const numStr = matchKw ? matchKw.at(1) : null;
    if (numStr) {
      const val = parseFloat(numStr.replace(',', '.'));
      if (!isNaN(val) && val > 0) {
        const kwCalcolati = val > 1000 ? Math.round(val / 1000) : Math.round(val);
        if (kwCalcolati >= 7) {
          potenzaKw = kwCalcolati;
        }
      }
    }
    if (
      String(rawPower).toLowerCase().includes('fast') ||
      String(rawPower).toLowerCase().includes('hpc') ||
      String(rawPower).toLowerCase().includes('dc')
    ) {
      if (potenzaKw < 50) potenzaKw = 50;
    }

    const isFastDc = potenzaKw >= 43;
    const { gestore, prezzo } = risolviTariffa(rawCpo, isFastDc);
    const tipoPresa = formattaPresa(rawPresa, potenzaKw);

    const indirizzo = [rawAddr, rawCity].filter(Boolean).join(', ') || `Posizione GPS (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

    parsed.push({
      gestore,
      prezzo,
      latitudine: lat,
      longitudine: lon,
      indirizzo,
      self: !isFastDc,
      potenzaKw,
      tipoPresa,
      tipoRicarica: `${tipoPresa} • ${potenzaKw} kW`,
    });
  }

  cacheColonnine = parsed;
  ultimoAggiornamentoCache = ora;
  console.log(`Dataset PUN caricato in memoria: ${parsed.length} colonnine`);
  return cacheColonnine;
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'API Colonnine EV Italia (PUN Nazionale) attiva',
    colonnineInCache: cacheColonnine.length,
    intestazioniCsv: ultimeIntestazioni,
  });
});

app.get('/api/colonnine', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng || req.query.lon);
    const raggioKm = Math.min(Math.max(parseFloat(req.query.raggio || req.query.radius || '10') || 10, 1), 50);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    const tutteLeColonnine = await caricaDatasetPun();

    const oggi = new Date().toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const risultati = [];
    for (const col of tutteLeColonnine) {
      if (Math.abs(col.latitudine - lat) > 0.6 || Math.abs(col.longitudine - lng) > 0.8) continue;

      const distKm = calcolaDistanzaKm(lat, lng, col.latitudine, col.longitudine);
      if (distKm <= raggioKm) {
        risultati.push({
          ...col,
          distanza: distKm.toFixed(1),
          data: oggi,
        });
      }
    }

    risultati.sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza));

    res.json(risultati.slice(0, 100));
  } catch (error) {
    console.error('Errore /api/colonnine:', error);
    res.status(500).json({ error: error.message || 'Errore durante il recupero delle colonnine' });
  }
});

app.listen(PORT, () => {
  console.log(`Server colonnine EV in ascolto sulla porta ${PORT}`);
  caricaDatasetPun().catch((err) => console.error('Precaricamento PUN fallito:', err.message));
});















