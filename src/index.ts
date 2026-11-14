import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

interface ColonninaRisposta {
  gestore: string;
  prezzo: number;
  latitudine: number;
  longitudine: number;
  indirizzo: string;
  distanza: string;
  self: boolean;
  data: string;
  potenzaKw?: number;
  tipoRicarica?: string;
}

const LISTINO_OPERATORI: Array<{
  keywords: string[];
  nomeUfficiale: string;
  ac: number;
  dc: number;
}> = [
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

function calcolaDistanzaKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

function estraiPotenzaKw(tags: Record<string, string>): number {
  let maxKw = 22;
  for (const [key, value] of Object.entries(tags)) {
    if (key.includes(':output') || key === 'maxpower' || key === 'power') {
      const match = String(value).match(/(\d+(?:[.,]\d+)?)/);
      if (match && match[1]) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (!isNaN(val) && val > maxKw) {
          maxKw = val;
        }
      }
    }
    if (key.includes('chademo') || key.includes('ccs') || key.includes('type2_combo')) {
      if (maxKw < 50) maxKw = 50;
    }
  }
  return maxKw;
}

function risolviTariffa(rawOperator: string, isFastDc: boolean): { gestore: string; prezzo: number } {
  const lower = rawOperator.toLowerCase();
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

function formattaIndirizzo(tags: Record<string, string>, lat: number, lon: number): string {
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

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'API Colonnine EV Italia attiva' });
});

app.get('/api/colonnine', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat((req.query.lng || req.query.lon) as string);
    const raggioKm = Math.min(Math.max(parseFloat((req.query.raggio || req.query.radius || '10') as string) || 10, 1), 30);

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
      return;
    }

    const raggioMetri = Math.round(raggioKm * 1000);
    const overpassQuery = `
      [out:json][timeout:15];
      (
        node["amenity"="charging_station"](around:${raggioMetri},${lat},${lng});
        way["amenity"="charging_station"](around:${raggioMetri},${lat},${lng});
      );
      out center tags;
    `;

    const response = await fetch('https://overpass-api.de', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(overpassQuery)}`,
    });

    if (!response.ok) {
      throw new Error(`Errore Overpass API: ${response.status}`);
    }

    const data = (await response.json()) as { elements?: any[] };
    const elements = data.elements || [];

    const oggi = new Date().toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const colonnine: ColonninaRisposta[] = elements
      .map((el) => {
        const cLat = el.lat ?? el.center?.lat;
        const cLon = el.lon ?? el.center?.lon;
        if (typeof cLat !== 'number' || typeof cLon !== 'number') return null;

        const tags: Record<string, string> = el.tags || {};
        if (tags.access === 'private') return null;

        const rawOperator = tags.operator || tags.brand || tags.network || tags.name || '';
        const potenzaKw = estraiPotenzaKw(tags);
        const isFastDc = potenzaKw >= 43;
        const { gestore, prezzo } = risolviTariffa(rawOperator, isFastDc);
        const distKm = calcolaDistanzaKm(lat, lng, cLat, cLon);

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
          tipoRicarica: isFastDc ? `Fast DC (${potenzaKw} kW)` : `Quick AC (${potenzaKw} kW)`,
        };
      })
      .filter((item): item is ColonninaRisposta => item !== null)
      .sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza));

    res.json(colonnine);
  } catch (error) {
    console.error('Errore /api/colonnine:', error);
    res.status(500).json({ error: 'Errore durante il recupero delle colonnine' });
  }
});

app.listen(PORT, () => {
  console.log(`Server colonnine EV in ascolto sulla porta ${PORT}`);
});
