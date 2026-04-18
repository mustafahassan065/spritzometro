import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Client ki specified cities — multiple search terms per city
const CITY_SEARCHES = [
  'bar aperitivo Milan Italy',
  'cocktail bar Milan Italy',
  'osteria Milan Italy',
  'pub Milan Italy',
  'bar Roma Italy',
  'aperitivo Roma Italy',
  'cocktail bar Roma Italy',
  'osteria Roma Italy',
  'bar Napoli Italy',
  'aperitivo Napoli Italy',
  'cocktail bar Napoli Italy',
  'bar Venezia Italy',
  'aperitivo Venezia Italy',
  'osteria Venezia Italy',
  'bar Firenze Italy',
  'aperitivo Firenze Italy',
  'cocktail bar Firenze Italy',
  'osteria Firenze Italy',
];

async function fetchAllPages(query) {
  let allResults = [];
  let pageToken = null;

  do {
    const params = { query, key: GMAPS_KEY, language: 'it' };
    if (pageToken) params.pagetoken = pageToken;

    const res = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params }
    );

    allResults = allResults.concat(res.data.results || []);
    pageToken = res.data.next_page_token || null;
    if (pageToken) await new Promise(r => setTimeout(r, 2000));

  } while (pageToken);

  return allResults;
}

async function getDetails(placeId) {
  const res = await axios.get(
    'https://maps.googleapis.com/maps/api/place/details/json',
    {
      params: {
        place_id: placeId,
        fields: 'name,formatted_phone_number,formatted_address,geometry',
        key: GMAPS_KEY,
        language: 'it'
      }
    }
  );
  return res.data.result;
}

function detectCity(address) {
  if (!address) return null;
  const addr = address.toLowerCase();
  if (addr.includes('milan') || addr.includes('milano')) return 'Milan';
  if (addr.includes('rome') || addr.includes('roma')) return 'Rome';
  if (addr.includes('naples') || addr.includes('napoli')) return 'Naples';
  if (addr.includes('venice') || addr.includes('venezia')) return 'Venice';
  if (addr.includes('florence') || addr.includes('firenze')) return 'Florence';
  return null;
}

export default async function handler(req, res) {
  // Auth check
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let totalAdded = 0;
  let totalSkipped = 0;
  const seenPlaceIds = new Set();

  for (const query of CITY_SEARCHES) {
    try {
      console.log(`Searching: ${query}`);
      const places = await fetchAllPages(query);

      for (const place of places) {
        // Skip duplicates within this run
        if (seenPlaceIds.has(place.place_id)) continue;
        seenPlaceIds.add(place.place_id);

        try {
          const d = await getDetails(place.place_id);
          if (!d.formatted_phone_number) { totalSkipped++; continue; }

          const city = detectCity(d.formatted_address);

          const { error } = await supabase.from('bars').upsert({
            name: d.name,
            address: d.formatted_address,
            city: city || 'Italy',
            phone: d.formatted_phone_number,
            latitude: d.geometry?.location?.lat,
            longitude: d.geometry?.location?.lng,
            place_id: place.place_id,
            call_count: 0,
            last_called_at: null
          }, { onConflict: 'place_id' });

          if (!error) totalAdded++;
          await new Promise(r => setTimeout(r, 200));

        } catch (err) {
          console.error(`Detail error: ${place.place_id}`, err.message);
        }
      }

      // Wait between queries
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`Search error: ${query}`, err.message);
    }
  }

  return res.json({
    status: 'done',
    bars_added: totalAdded,
    bars_skipped_no_phone: totalSkipped,
    total_searched: seenPlaceIds.size
  });
}
