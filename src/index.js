const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

// Endpoint ufficiale Piattaforma Unica Nazionale (PUN - MASE/GSE)
const PUN_ARCGIS_URL =
  'https://arcgis.com';

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

function risolviTariffa(rawOperator, isFastDc) {
  const lower = String(rawOperator || '').toLowerCase();
  for (const op of LISTINO_OPERATORI) {
    if (op.keywords.some((kw) => lower.includes(kw))) {
      return {
        gestore: op.nomeUfficiale,
        prezzo: isFastDc ? op.dc : op.ac,
      };
    }
  }
  return {
    gestore: rawOperator || 'Colonnina Pubblica EV',
    prezzo: isFastDc ? 0.74 : 0.62,
  };
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'API Colonnine EV Italia (PUN Nazionale) attiva' });
});

app.get('/api/colonnine', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng || req.query.lon);
    const raggioKm = Math.min(Math.max(parseFloat(req.query.raggio || req.query.radius || '10') || 10, 1), 50);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    // Calcolo bounding box geografico intorno all'utente
    const deltaLat = raggioKm / 111.0;
    const deltaLon = raggioKm / (111.0 * Math.cos((lat * Math.PI) / 180));
    const minLat = lat - deltaLat;
    const maxLat = lat + deltaLat;
    const minLon = lng - deltaLon;
    const maxLon = lng + deltaLon;

    const params = new URLSearchParams({
      where: '1=1',
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
    });

    const response = await fetch(`${PUN_ARCGIS_URL}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Errore servizio PUN: ${response.status}`);
    }

    const data = await response.json();
    const features = data.features || [];

    const oggi = new Date().toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const risultati = [];

    for (const f of features) {
      const attrs = f.attributes || {};
      const geom = f.geometry || {};

      const cLat = typeof geom.y === 'number' ? geom.y : parseFloat(attrs.latitudine || attrs.lat || attrs.Y);
      const cLon = typeof geom.x === 'number' ? geom.x : parseFloat(attrs.longitudine || attrs.lon || attrs.X);

      if (isNaN(cLat) || isNaN(cLon)) continue;

      const distKm = calcolaDistanzaKm(lat, lng, cLat, cLon);
      if (distKm > raggioKm) continue;

      const rawCpo =
        attrs.cpo ||
        attrs.gestore ||
        attrs.operatore ||
        attrs.denominazione ||
        attrs.CPO ||
        attrs.GESTORE ||
        'Colonnina Pubblica EV';

      const rawPower =
        attrs.potenza_max ||
        attrs.potenza ||
        attrs.POTENZA ||
        attrs.tipologia ||
        attrs.TIPOLOGIA ||
        '';

      let potenzaKw = 22;
      const matchKw = String(rawPower).match(/(\d+(?:[.,]\d+)?)/);
      const numStr = matchKw ? matchKw.at(1) : null;
      if (numStr) {
        const val = parseFloat(numStr.replace(',', '.'));
        if (!isNaN(val) && val > 0) {
          potenzaKw = val > 1000 ? Math.round(val / 1000) : val;
        }
      }
      if (String(rawPower).toLowerCase().includes('fast') || String(rawPower).toLowerCase().includes('hpc')) {
        if (potenzaKw < 50) potenzaKw = 50;
      }

      const isFastDc = potenzaKw >= 43;
      const { gestore, prezzo } = risolviTariffa(rawCpo, isFastDc);

      const via = attrs.indirizzo || attrs.INDIRIZZO || attrs.via || '';
      const comune = attrs.comune || attrs.COMUNE || attrs.citta || '';
      const indirizzo =
        [via, comune].filter(Boolean).join(', ') || `Posizione GPS (${cLat.toFixed(4)}, ${cLon.toFixed(4)})`;

      risultati.push({
        gestore,
        prezzo,
        latitudine: cLat,
        longitudine: cLon,
        indirizzo,
        distanza: distKm.toFixed(1),
        self: !isFastDc,
        data: oggi,
        potenzaKw,
        tipoRicarica: isFastDc ? `Fast DC (${potenzaKw} kW)` : `Quick AC (${potenzaKw} kW)`,
      });
    }

    risultati.sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza));

    res.json(risultati.slice(0, 100));
  } catch (error) {
    console.error('Errore /api/colonnine:', error);
    res.status(500).json({ error: error.message || 'Errore durante il recupero delle colonnine' });
  }
});

app.listen(PORT, () => {
  console.log(`Server colonnine EV (PUN) in ascolto sulla porta ${PORT}`);
});


