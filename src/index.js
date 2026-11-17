const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const PUN_CSV_URL =
  'https://raw.githubusercontent.com/ondata/rete_ricarica_veicoli_elettrici/main/data/rete_ricarica_veicoli_elettrici.csv';

const CODICI_EMIO3 = {
  BEC: { nomeUfficiale: 'Plenitude + Be Charge', ac: 0.65, dc: 0.85 },
  ENL: { nomeUfficiale: 'Enel X Way', ac: 0.67, dc: 0.75 },
  ENX: { nomeUfficiale: 'Enel X Way', ac: 0.67, dc: 0.75 },
  EWI: { nomeUfficiale: 'Ewiva', ac: 0.75, dc: 0.80 },
  A2A: { nomeUfficiale: 'A2A E-Moving', ac: 0.65, dc: 0.90 },
  DUF: { nomeUfficiale: 'Duferco Energia', ac: 0.74, dc: 0.79 },
  ELC: { nomeUfficiale: 'Electra', ac: 0.54, dc: 0.54 },
  ELP: { nomeUfficiale: 'Electrip', ac: 0.75, dc: 0.80 },
  ION: { nomeUfficiale: 'Ionity', ac: 0.85, dc: 0.85 },
  ATL: { nomeUfficiale: 'Atlante', ac: 0.69, dc: 0.85 },
  FTX: { nomeUfficiale: 'Free To X', ac: 0.75, dc: 0.85 },
  NEO: { nomeUfficiale: 'Neogy', ac: 0.65, dc: 0.82 },
  HER: { nomeUfficiale: 'Hera Comm', ac: 0.66, dc: 0.84 },
  IRE: { nomeUfficiale: 'IrenGO', ac: 0.65, dc: 0.82 },
  ACE: { nomeUfficiale: 'Acea Energia', ac: 0.65, dc: 0.83 },
  TSL: { nomeUfficiale: 'Tesla Supercharger', ac: 0.55, dc: 0.65 },
  REP: { nomeUfficiale: 'Repower', ac: 0.68, dc: 0.82 },
  PWI: { nomeUfficiale: 'Powy', ac: 0.65, dc: 0.80 },
  GAS: { nomeUfficiale: 'GasGas', ac: 0.65, dc: 0.79 },
  UAT: { nomeUfficiale: 'Uattzy', ac: 0.60, dc: 0.75 },
  UTZ: { nomeUfficiale: 'Uattzy', ac: 0.60, dc: 0.75 },
};

let cacheColonnine = [];
let ultimoAggiornamentoCache = 0;
const DURATA_CACHE_MS = 24 * 60 * 60 * 1000;

const cacheOsmZone = new Map();
const DURATA_CACHE_OSM_MS = 6 * 60 * 60 * 1000;

function scaricaTestoHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { family: 4, headers: { 'User-Agent': 'ColonnineEVItaliaApp/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(scaricaTestoHttps(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP status ' + res.statusCode));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function postOverpassHttps(query) {
  return new Promise((resolve, reject) => {
    const postData = 'data=' + encodeURIComponent(query);
    const options = {
      hostname: 'overpass-api.de',
      path: '/api/interpreter',
      method: 'POST',
      family: 4,
      timeout: 8000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'ColonnineEVItaliaApp/1.0',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('Overpass HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Overpass timeout'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
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

function stimaTariffaDaNome(nomeGestore, isFastDc) {
  const upper = String(nomeGestore || '').toUpperCase();
  if (upper.includes('UATTZY')) return isFastDc ? 0.75 : 0.60;
  if (upper.includes('ENEL')) return isFastDc ? 0.75 : 0.67;
  if (upper.includes('PLENITUDE') || upper.includes('BE CHARGE')) return isFastDc ? 0.85 : 0.65;
  if (upper.includes('EWIVA')) return isFastDc ? 0.80 : 0.75;
  if (upper.includes('A2A')) return isFastDc ? 0.90 : 0.65;
  if (upper.includes('DUFERCO')) return isFastDc ? 0.79 : 0.74;
  if (upper.includes('ELECTRA')) return 0.54;
  if (upper.includes('IONITY')) return 0.85;
  if (upper.includes('ATLANTE')) return isFastDc ? 0.85 : 0.69;
  if (upper.includes('TESLA')) return isFastDc ? 0.65 : 0.55;
  if (upper.includes('POWY')) return isFastDc ? 0.80 : 0.65;
  return isFastDc ? 0.74 : 0.62;
}

function risolviOperatoreETariffa(evseId, nomeLocation, isFastDc) {
  const strId = String(evseId || '').toUpperCase();
  const parti = strId.split('*');
  if (parti.length >= 2 && parti.at(0) === 'IT') {
    const sigla = parti.at(1);
    if (CODICI_EMIO3[sigla]) {
      const op = CODICI_EMIO3[sigla];
      return {
        gestore: op.nomeUfficiale,
        prezzo: isFastDc ? op.dc : op.ac,
      };
    }
  }
  const loc = String(nomeLocation || '').trim();
  const idxDash = loc.indexOf(' - ');
  const nomePulito = idxDash > 0 ? loc.substring(0, idxDash).trim() : loc;
  const gestoreFinale = nomePulito || 'Colonnina Pubblica EV';
  return {
    gestore: gestoreFinale,
    prezzo: stimaTariffaDaNome(gestoreFinale, isFastDc),
  };
}

function traduciConnettore(rawConn) {
  const c = String(rawConn || '').toUpperCase();
  if (c.includes('T2_COMBO') || c.includes('CCS')) return 'CCS2 Combo';
  if (c.includes('T2')) return 'Tipo 2';
  if (c.includes('T3A')) return 'Tipo 3A';
  if (c.includes('CHADEMO')) return 'CHAdeMO';
  if (c.includes('DOMESTIC') || c.includes('SCHUKO')) return 'Schuko';
  return 'Tipo 2';
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
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('Dataset PUN vuoto');
  }

  const headerLine = lines.at(0);
  const sep = headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
  const headers = parseCsvLine(headerLine, sep).map((h) => h.toLowerCase().trim());

  const idxLat = headers.findIndex((h) => h === 'latitudine_evse' || h === 'latitudine' || h === 'y');
  const idxLon = headers.findIndex((h) => h === 'longitudine_evse' || h === 'longitudine' || h === 'x');
  const idxEvse = headers.findIndex((h) => h === 'id_univoco_evse');
  const idxLoc = headers.findIndex((h) => h === 'nome_location');
  const idxAddr = headers.findIndex((h) => h === 'indirizzo');
  const idxCity = headers.findIndex((h) => h === 'comune' || h === 'città' || h === 'citta');
  const idxPower = headers.findIndex((h) => h === 'potenza_erogabile');
  const idxConn = headers.findIndex((h) => h === 'standard_del_connettore');
  const idxFascia = headers.findIndex((h) => h === 'fasce_di_potenza');

  if (idxLat < 0 || idxLon < 0) {
    throw new Error('Colonne coordinate non trovate nel CSV');
  }

  const stazioniObj = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines.at(i);
    if (!line || line.trim().length === 0) continue;

    const cols = parseCsvLine(line, sep);
    const lat = parseFloat((cols.at(idxLat) || '').replace(',', '.'));
    const lon = parseFloat((cols.at(idxLon) || '').replace(',', '.'));
    if (isNaN(lat) || isNaN(lon) || lat < 35 || lat > 48 || lon < 6 || lon > 19) continue;

    const evseId = idxEvse >= 0 ? cols.at(idxEvse) : '';
    const nomeLoc = idxLoc >= 0 ? cols.at(idxLoc) : '';
    const rawAddr = idxAddr >= 0 ? cols.at(idxAddr) : '';
    const rawCity = idxCity >= 0 ? cols.at(idxCity) : '';
    const rawPower = idxPower >= 0 ? cols.at(idxPower) : '';
    const rawConn = idxConn >= 0 ? cols.at(idxConn) : '';
    const rawFascia = idxFascia >= 0 ? cols.at(idxFascia) : '';

    let potenzaKw = 22;
    const valW = parseFloat(String(rawPower || '').replace(',', '.'));
    if (!isNaN(valW) && valW > 0) {
      potenzaKw = valW >= 1000 ? Math.round(valW / 1000) : Math.round(valW);
    }

    const isFastDc =
      potenzaKw >= 43 ||
      String(rawFascia || '').toLowerCase().includes('veloce') ||
      String(rawConn || '').toUpperCase().includes('COMBO');

    const opInfo = risolviOperatoreETariffa(evseId, nomeLoc, isFastDc);
    const presa = traduciConnettore(rawConn);
    const indirizzo =
      [rawAddr, rawCity].filter(Boolean).join(', ') ||
      'Posizione GPS (' + lat.toFixed(4) + ', ' + lon.toFixed(4) + ')';

    const chiavePos = lat.toFixed(5) + '_' + lon.toFixed(5) + '_' + opInfo.gestore;
    const esistente = stazioniObj[chiavePos];

    if (esistente) {
      if (!esistente.prese.includes(presa)) {
        esistente.prese = esistente.prese + ', ' + presa;
      }
      if (potenzaKw > esistente.potenzaKw) {
        esistente.potenzaKw = potenzaKw;
        esistente.prezzo = opInfo.prezzo;
        esistente.self = !isFastDc;
      }
      const isFast = esistente.potenzaKw >= 43;
      esistente.tipoRicarica =
        (isFast ? 'Fast DC' : 'Ricarica AC') +
        ' (' +
        esistente.potenzaKw +
        ' kW) • ' +
        esistente.prese;
    } else {
      const isFast = potenzaKw >= 43;
      stazioniObj[chiavePos] = {
        gestore: opInfo.gestore,
        prezzo: opInfo.prezzo,
        latitudine: lat,
        longitudine: lon,
        indirizzo: indirizzo,
        self: !isFastDc,
        potenzaKw: potenzaKw,
        prese: presa,
        tipoRicarica:
          (isFast ? 'Fast DC' : 'Ricarica AC') +
          ' (' +
          potenzaKw +
          ' kW) • ' +
          presa,
      };
    }
  }

  cacheColonnine = Object.values(stazioniObj);
  ultimoAggiornamentoCache = ora;
  console.log('Dataset PUN caricato in memoria: ' + cacheColonnine.length + ' stazioni uniche');
  return cacheColonnine;
}

async function cercaColonnineOsm(lat, lng, raggioKm) {
  const key = lat.toFixed(2) + '_' + lng.toFixed(2) + '_' + Math.ceil(raggioKm);
  const ora = Date.now();
  const cached = cacheOsmZone.get(key);
  if (cached && ora - cached.timestamp < DURATA_CACHE_OSM_MS) {
    return cached.data;
  }

  const raggioMetri = Math.round(raggioKm * 1000);
  const overpassQuery = `[out:json][timeout:8];(node["amenity"="charging_station"](around:${raggioMetri},${lat},${lng});way["amenity"="charging_station"](around:${raggioMetri},${lat},${lng}););out center tags;`;

  try {
    const rawJson = await postOverpassHttps(overpassQuery);
    const parsed = JSON.parse(rawJson);
    const elements = Array.isArray(parsed.elements) ? parsed.elements : [];

    const stazioniOsm = [];
    for (const el of elements) {
      const elLat = el.lat !== undefined ? el.lat : el.center && el.center.lat;
      const elLon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
      if (typeof elLat !== 'number' || typeof elLon !== 'number') continue;

      const tags = el.tags || {};
      const gestore =
        tags.operator ||
        tags.network ||
        tags.brand ||
        tags.name ||
        'Colonnina Pubblica EV';

      let potenzaKw = 22;
      const outputStr =
        tags['socket:type2_combo:output'] ||
        tags['socket:type2:output'] ||
        tags.output ||
        tags.power ||
        '';
      const matchKw = String(outputStr).match(/(\d+(?:[.,]\d+)?)/);
      if (matchKw) {
        const val = parseFloat(matchKw.at(1).replace(',', '.'));
        if (!isNaN(val) && val > 0) {
          potenzaKw = val >= 1000 ? Math.round(val / 1000) : Math.round(val);
        }
      }

      const preseList = [];
      if (tags['socket:type2_combo']) preseList.push('CCS2 Combo');
      if (tags['socket:type2']) preseList.push('Tipo 2');
      if (tags['socket:chademo']) preseList.push('CHAdeMO');
      if (tags['socket:type3a']) preseList.push('Tipo 3A');
      if (tags['socket:schuko']) preseList.push('Schuko');
      if (preseList.length === 0) preseList.push('Tipo 2');

      const isFastDc = potenzaKw >= 43 || preseList.includes('CCS2 Combo');
      const preseStr = preseList.join(', ');
      const via = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
      const citta = tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || '';
      const indirizzo =
        [via, citta].filter(Boolean).join(', ') ||
        tags.description ||
        'Posizione GPS (' + elLat.toFixed(4) + ', ' + elLon.toFixed(4) + ')';

      stazioniOsm.push({
        gestore: gestore,
        prezzo: stimaTariffaDaNome(gestore, isFastDc),
        latitudine: elLat,
        longitudine: elLon,
        indirizzo: indirizzo,
        self: !isFastDc,
        potenzaKw: potenzaKw,
        prese: preseStr,
        tipoRicarica:
          (isFastDc ? 'Fast DC' : 'Ricarica AC') +
          ' (' +
          potenzaKw +
          ' kW) • ' +
          preseStr,
      });
    }

    cacheOsmZone.set(key, { timestamp: ora, data: stazioniOsm });
    return stazioniOsm;
  } catch (err) {
    console.warn('Fallback solo PUN (Overpass non disponibile):', err.message);
    return [];
  }
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'API Colonnine EV Italia (PUN + OpenStreetMap) attiva',
    colonnineInCache: cacheColonnine.length,
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

    const [tutteLeColonninePun, colonnineOsm] = await Promise.all([
      caricaDatasetPun(),
      cercaColonnineOsm(lat, lng, raggioKm),
    ]);

    const oggi = new Date().toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const risultati = [];

    for (let i = 0; i < tutteLeColonninePun.length; i++) {
      const col = tutteLeColonninePun.at(i);
      if (Math.abs(col.latitudine - lat) > 0.6 || Math.abs(col.longitudine - lng) > 0.8) continue;

      const distKm = calcolaDistanzaKm(lat, lng, col.latitudine, col.longitudine);
      if (distKm <= raggioKm) {
        risultati.push({
          gestore: col.gestore,
          prezzo: col.prezzo,
          latitudine: col.latitudine,
          longitudine: col.longitudine,
          indirizzo: col.indirizzo,
          self: col.self,
          potenzaKw: col.potenzaKw,
          prese: col.prese,
          tipoRicarica: col.tipoRicarica,
          distanza: distKm.toFixed(1),
          data: oggi,
        });
      }
    }

    for (const osmCol of colonnineOsm) {
      const distKm = calcolaDistanzaKm(lat, lng, osmCol.latitudine, osmCol.longitudine);
      if (distKm > raggioKm) continue;

      const giaPresente = risultati.some(
        (r) => calcolaDistanzaKm(r.latitudine, r.longitudine, osmCol.latitudine, osmCol.longitudine) < 0.06
      );

      if (!giaPresente) {
        risultati.push({
          gestore: osmCol.gestore,
          prezzo: osmCol.prezzo,
          latitudine: osmCol.latitudine,
          longitudine: osmCol.longitudine,
          indirizzo: osmCol.indirizzo,
          self: osmCol.self,
          potenzaKw: osmCol.potenzaKw,
          prese: osmCol.prese,
          tipoRicarica: osmCol.tipoRicarica,
          distanza: distKm.toFixed(1),
          data: oggi,
        });
      }
    }

    risultati.sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza));
    res.json(risultati);
  } catch (err) {
    console.error('Errore /api/colonnine:', err.message);
    res.status(500).json({
      error: 'Errore interno durante la ricerca colonnine',
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log('Server Colonnine EV in ascolto sulla porta ' + PORT);
});
