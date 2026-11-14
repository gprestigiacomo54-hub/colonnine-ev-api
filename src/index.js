const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const OVERPASS_HOSTS = [
  'https://overpass-api.de',
  'https://kumi.systems',
  'https://mail.ru' + '/osm/tools/overpass',
];

const LISTINO_OPERATORI = [
  { keywords: ['tesla'], nomeUfficiale: 'Tesla Supercharger', ac: 0.55, dc: 0.65 },
  { keywords: ['electra'], nomeUfficiale: 'Electra', ac: 0.54, dc: 0.54 },
  { keywords: ['enel', 'enel x', 'enelx', 'q83082068'], nomeUfficiale: 'Enel X Way', ac: 0.67, dc: 0.75 },
  { keywords: ['plenitude', 'be charge', 'becharge', 'eni', 'q105756478'], nomeUfficiale: 'Plenitude + Be Charge', ac: 0.65, dc: 0.85 },
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

function estraiPotenzaEPresa(tags) {
  let maxKw = 0;
  const preseTrovate = [];

  for (const [key, value] of Object.entries(tags)) {
    const k = key.toLowerCase();
    const v = String(value).toLowerCase();

    if (k.startsWith('socket:type2_combo') || k.includes('ccs')) {
      if (v !== 'no' && !preseTrovate.includes('CCS Combo 2')) preseTrovate.push('CCS Combo 2');
      if (maxKw < 50) maxKw = 50;
    } else if (k.startsWith('socket:chademo')) {
      if (v !== 'no' && !preseTrovate.includes('CHAdeMO')) preseTrovate.push('CHAdeMO');
      if (maxKw < 50) maxKw = 50;
    } else if (k === 'socket:type2' || k.startsWith('socket:type2:')) {
      if (v !== 'no' && !preseTrovate.includes('Tipo 2')) preseTrovate.push('Tipo 2');
    } else if (k.startsWith('socket:type3')) {
      if (v !== 'no' && !preseTrovate.includes('Tipo 3A')) preseTrovate.push('Tipo 3A');
    } else if (k.startsWith('socket:schuko')) {
      if (v !== 'no' && !preseTrovate.includes('Schuko')) preseTrovate.push('Schuko');
    }

    if (k.includes(':output') || k === 'maxpower' || k === 'power') {
      const match = v.match(/(\d+(?:[.,]\d+)?)/);
      const primoNumero = match ? match.at(1) : null;
      if (primoNumero) {
        let val = parseFloat(primoNumero.replace(',', '.'));
        if (v.includes('w') && !v.includes('kw') && val > 1000) {
          val = val / 1000;
        }
        if (!isNaN(val) && val > maxKw) {
          maxKw = Math.round(val);
        }
      }
    }
  }

  if (maxKw === 0) maxKw = 22;
  const tipoPresa =
    preseTrovate.length > 0
      ? preseTrovate.join(' / ')
      : maxKw >= 43
      ? 'CCS Combo 2'
      : 'Tipo 2';

  return { potenzaKw: maxKw, tipoPresa };
}

function risolviTariffa(tags, isFastDc) {
  const candidati = [
    tags.operator,
    tags.brand,
    tags.network,
    tags.name,
    tags.description,
    tags['operator:wikidata'],
    tags['brand:wikidata'],
  ]
    .filter(Boolean)
    .join(' ');

  const lower = candidati.toLowerCase();

  for (const op of LISTINO_OPERATORI) {
    if (op.keywords.some((kw) => lower.includes(kw))) {
      return {
        gestore: op.nomeUfficiale,
        prezzo: isFastDc ? op.dc : op.ac,
      };
    }
  }

  const nomePulito = tags.operator || tags.brand || tags.network || tags.name || '';
  return {
    gestore: nomePulito.trim() || 'Colonnina Pubblica EV',
    prezzo: isFastDc ? 0.74 : 0.62,
  };
}

function formattaIndirizzo(tags, lat, lon) {
  const via = tags['addr:street'] || tags['street'] || '';
  const civico = tags['addr:housenumber'] || '';
  const citta = tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || '';
  const luogo = tags['name'] || '';

  const strada = [via, civico].filter(Boolean).join(' ');
  const parti = [strada, citta].filter(Boolean);

  if (parti.length > 0) return parti.join(', ');
  if (luogo) return luogo;
  return `Posizione GPS (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
}

async function interrogaOverpassConFallback(overpassQuery) {
  let ultimoErrore = null;

  for (const host of OVERPASS_HOSTS) {
    const endpoint = `${host}/api/interpreter`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ColonnineEVItaliaApp/1.0',
        },
        body: `data=${encodeURIComponent(overpassQuery)}`,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        ultimoErrore = `HTTP ${response.status} da ${endpoint}`;
        continue;
      }

      const data = await response.json();
      if (data && Array.isArray(data.elements)) {
        return data.elements;
      }
    } catch (err) {
      ultimoErrore = `${endpoint}: ${err.message}`;
    }
  }

  throw new Error(ultimoErrore || 'Tutti i server Overpass sono momentaneamente occupati');
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'API Colonnine EV Italia attiva' });
});

app.get('/api/colonnine', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng || req.query.lon);
    const raggioKm = Math.min(Math.max(parseFloat(req.query.raggio || req.query.radius || '10') || 10, 1), 30);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    // Calcolo riquadro geografico (bbox) per query istantanea su Overpass
    const deltaLat = raggioKm / 111.32;
    const deltaLng = raggioKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    const minLat = (lat - deltaLat).toFixed(5);
    const maxLat = (lat + deltaLat).toFixed(5);
    const minLng = (lng - deltaLng).toFixed(5);
    const maxLng = (lng + deltaLng).toFixed(5);

    const overpassQuery = `
      [out:json][timeout:18][bbox:${minLat},${minLng},${maxLat},${maxLng}];
      (
        node["amenity"="charging_station"];
        way["amenity"="charging_station"];
      );
      out center tags;
    `;

    const elements = await interrogaOverpassConFallback(overpassQuery);

    const oggi = new Date().toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const colonnine = elements
      .map((el) => {
        const cLat = el.lat ?? el.center?.lat;
        const cLon = el.lon ?? el.center?.lon;
        if (typeof cLat !== 'number' || typeof cLon !== 'number') return null;

        const tags = el.tags || {};
        if (tags.access === 'private') return null;

        const distKm = calcolaDistanzaKm(lat, lng, cLat, cLon);
        if (distKm > raggioKm) return null;

        const { potenzaKw, tipoPresa } = estraiPotenzaEPresa(tags);
        const isFastDc = potenzaKw >= 43;
        const { gestore, prezzo } = risolviTariffa(tags, isFastDc);

        return {
          gestore,
          prezzo,
          latitudine: cLat,
          longitudine: cLon,
          indirizzo: formattaIndirizzo(tags, cLat, cLon),
          distanza: distKm.toFixed(1),
          self: !isFastDc,
          data: oggi,
          potenzaKw,
          tipoPresa,
          tipoRicarica: `${tipoPresa} • ${potenzaKw} kW`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza));

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










