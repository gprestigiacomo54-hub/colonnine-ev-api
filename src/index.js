const express = require('express');
const cors = require('cors');

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
let ultimoAggiornamento = 0;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

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

function parseCSVLine(line, separator) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === separator && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function risolviOperatoreETariffa(rawOperator, isFastDc) {
  const pulito = (rawOperator || '').replace(/^["']|["']$/g, '').trim();
  const lower = pulito.toLowerCase();

  for (const op of LISTINO_OPERATORI) {
    if (op.keywords.some((kw) => lower.includes(kw))) {
      return {
        gestore: op.nomeUfficiale,
        prezzo: isFastDc ? op.dc : op.ac,
      };
    }
  }

  return {
    gestore: pulito && lower !== 'nd' && lower !== 'n/d' ? pulito : 'Colonnina Pubblica EV',
    prezzo: isFastDc ? 0.74 : 0.62,
  };
}

function formattaPresa(rawPresa, potenzaKw) {
  const p = (rawPresa || '').toLowerCase();
  if (p.includes('ccs') || p.includes('combo')) return 'CCS Combo 2';
  if (p.includes('chademo')) return 'CHAdeMO';
  if (p.includes('type 2') || p.includes('tipo 2') || p.includes('mennekes') || p.includes('t2')) {
    return 'Tipo 2';
  }
  if (p.includes('type 3') || p.includes('tipo 3') || p.includes('scame')) return 'Tipo 3A';
  if (p.includes('schuko')) return 'Schuko';

  return potenzaKw >= 43 ? 'CCS Combo 2' : 'Tipo 2';
}

async function caricaDatasetInCache() {
  const ora = Date.now();
  if (cacheColonnine.length > 0 && ora - ultimoAggiornamento < CACHE_TTL_MS) {
    return cacheColonnine;
  }

  const response = await fetch(PUN_CSV_URL, {
    headers: { 'User-Agent': 'ColonnineEVItaliaApp/1.0' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} scaricando il dataset PUN`);
  }

  const text = await response.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('Dataset CSV vuoto');
  }

  const firstLine = lines.at(0);
  const separator = firstLine.includes(';') ? ';' : ',';
  const headers = parseCSVLine(firstLine, separator).map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/^["'\uFEFF]|["']$/g, '')
      .trim()
  );

  const findIdx = (keywords) =>
    headers.findIndex((h) => keywords.some((kw) => h === kw || h.includes(kw)));

  const idxLat = findIdx(['latitudine', 'latitude', 'lat', 'y']);
  const idxLng = findIdx(['longitudine', 'longitude', 'lon', 'lng', 'x']);
  const idxGestore = findIdx([
    'operatore',
    'gestore',
    'cpo',
    'denominazione',
    'ragione_sociale',
    'ragione sociale',
    'owner',
    'brand',
    'nome',
  ]);
  const idxIndirizzo = findIdx(['indirizzo', 'address', 'via', 'ubicazione', 'localita', 'location']);
  const idxComune = findIdx(['comune', 'citta', 'city', 'municipality']);
  const idxProvincia = findIdx(['provincia', 'province', 'prov']);
  const idxPotenza = findIdx(['potenza', 'power', 'kw', 'max_power', 'potenza_kw', 'potenza massima']);
  const idxPresa = findIdx([
    'presa',
    'connettore',
    'connector',
    'tipo_presa',
    'tipo presa',
    'tipologia presa',
    'socket',
    'standard',
  ]);

  const oggi = new Date().toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const parsed = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines.at(i), separator);
    if (cols.length < 3) continue;

    const lat = parseFloat((cols.at(idxLat) || '').replace(',', '.'));
    const lng = parseFloat((cols.at(idxLng) || '').replace(',', '.'));
    if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) continue;

    let potenzaKw = 22;
    if (idxPotenza !== -1 && cols.at(idxPotenza)) {
      const pVal = parseFloat(cols.at(idxPotenza).replace(',', '.').replace(/[^\d.]/g, ''));
      if (!isNaN(pVal) && pVal > 0) {
        potenzaKw = pVal > 1000 ? Math.round(pVal / 1000) : Math.round(pVal);
      }
    }

    const isFastDc = potenzaKw >= 43;
    const rawGestore = idxGestore !== -1 ? cols.at(idxGestore) : '';
    const { gestore, prezzo } = risolviOperatoreETariffa(rawGestore, isFastDc);
    const tipoPresa = formattaPresa(idxPresa !== -1 ? cols.at(idxPresa) : '', potenzaKw);

    const via = idxIndirizzo !== -1 ? cols.at(idxIndirizzo) : '';
    const comune = idxComune !== -1 ? cols.at(idxComune) : '';
    const prov = idxProvincia !== -1 ? cols.at(idxProvincia) : '';

    const indirizzo =
      [via, comune, prov ? `(${prov})` : '']
        .filter((p) => p && p.trim().length > 0)
        .join(', ')
        .replace(', (', ' (') || `Posizione GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

    parsed.push({
      gestore,
      prezzo,
      latitudine: lat,
      longitudine: lng,
      indirizzo,
      self: !isFastDc,
      data: oggi,
      potenzaKw,
      tipoPresa,
      tipoRicarica: `${tipoPresa} • ${potenzaKw} kW`,
    });
  }

  cacheColonnine = parsed;
  ultimoAggiornamento = ora;
  console.log(`Cache aggiornata: ${cacheColonnine.length} colonnine caricate.`);
  return cacheColonnine;
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'API Colonnine EV Italia attiva (Cache PUN)',
    totaleInCache: cacheColonnine.length,
  });
});

app.get('/api/colonnine', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng || req.query.lon);
    const raggioKm = Math.min(
      Math.max(parseFloat(req.query.raggio || req.query.radius || '10') || 10, 1),
      50
    );

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    const tutte = await caricaDatasetInCache();

    const colonnine = tutte
      .map((c) => {
        const distKm = calcolaDistanzaKm(lat, lng, c.latitudine, c.longitudine);
        return {
          ...c,
          distanza: distKm.toFixed(1),
        };
      })
      .filter((c) => parseFloat(c.distanza) <= raggioKm)
      .sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza))
      .slice(0, 40);

    res.json(colonnine);
  } catch (error) {
    console.error('Errore /api/colonnine:', error);
    res.status(500).json({
      error: 'Errore durante il recupero delle colonnine',
      dettagli: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server colonnine EV in ascolto sulla porta ${PORT}`);
});











