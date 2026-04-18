// api/campaign.js — Vercel Edge Function
// Runs every 15 minutes via cron (vercel.json)

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VAPI_API_KEY  = process.env.VAPI_API_KEY;
const ASSISTANT_ID  = process.env.VAPI_ASSISTANT_ID;
const PHONE_ID      = process.env.VAPI_PHONE_ID;
const GMAPS_KEY     = process.env.GOOGLE_MAPS_API_KEY;

// Cities client ne specify ki hain
const CITIES = ['Milan', 'Rome', 'Naples', 'Venice', 'Florence'];

// ── Italian time ──
function getItalyTime() {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const offset = isDST ? 2 : 1;
  const it = new Date(now.getTime() + offset * 3600000);
  return {
    hour: it.getUTCHours(),
    minute: it.getUTCMinutes(),
    day: it.getUTCDay(),
    decimal: it.getUTCHours() + it.getUTCMinutes() / 60
  };
}

// ── Contact window check ──
function isContactWindow(it) {
  const { day, decimal } = it;
  if (day >= 1 && day <= 4) return (decimal >= 10.0 && decimal < 11.5) || (decimal >= 15.5 && decimal < 17.5);
  if (day === 5)            return (decimal >= 10.0 && decimal < 11.5) || (decimal >= 15.0 && decimal < 16.5);
  if (day === 6)            return decimal >= 10.5 && decimal < 11.5;
  if (day === 0)            return decimal >= 11.0 && decimal < 12.0;
  return false;
}

// ── Fetch new bars from Google Maps ──
async function fetchNewBarsForCity(city) {
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query: `bar spritz ${city} Italy`, key: GMAPS_KEY, language: 'it' }
    });

    const places = res.data.results || [];
    let added = 0;

    for (const place of places.slice(0, 5)) {
      // Get phone number
      const details = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
        params: { place_id: place.place_id, fields: 'name,formatted_phone_number,formatted_address,geometry', key: GMAPS_KEY, language: 'it' }
      });

      const d = details.data.result;
      if (!d.formatted_phone_number) continue;

      const { error } = await supabase.from('bars').upsert({
        name: d.name,
        address: d.formatted_address,
        city,
        phone: d.formatted_phone_number,
        latitude: d.geometry?.location?.lat,
        longitude: d.geometry?.location?.lng,
        place_id: place.place_id,
        call_count: 0,
        last_called_at: null
      }, { onConflict: 'place_id' });

      if (!error) added++;
      await new Promise(r => setTimeout(r, 200));
    }

    return added;
  } catch (err) {
    console.error(`fetchBars error for ${city}:`, err.message);
    return 0;
  }
}

// ── Auto-reset weekly counter ──
async function handleWeekReset(settings) {
  const weekStart = new Date(settings.week_start_date);
  const now = new Date();
  const daysDiff = Math.floor((now - weekStart) / 86400000);

  if (daysDiff >= 7) {
    console.log('📅 New week — resetting counters and re-queuing all bars');

    // Reset all bars' last_called_at so they get called again
    await supabase.from('bars').update({ last_called_at: null }).neq('id', '00000000-0000-0000-0000-000000000000');

    // Remove bars with 3+ failed calls (no price ever recorded)
    const { data: failedBars } = await supabase
      .from('bars')
      .select('id')
      .gte('call_count', 3);

    if (failedBars && failedBars.length > 0) {
      console.log(`🗑️  Removing ${failedBars.length} unresponsive bars`);

      // Check which ones have no prices
      for (const bar of failedBars) {
        const { data: prices } = await supabase
          .from('prices')
          .select('id')
          .eq('bar_id', bar.id)
          .limit(1);

        if (!prices || prices.length === 0) {
          await supabase.from('bars').delete().eq('id', bar.id);
        }
      }

      // Fetch replacements from Google Maps
      console.log('🔍 Fetching replacement bars...');
      let totalAdded = 0;
      for (const city of CITIES) {
        const added = await fetchNewBarsForCity(city);
        totalAdded += added;
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`✅ Added ${totalAdded} new bars`);
    }

    // Reset weekly counter
    await supabase.from('campaign_settings').update({
      current_week_calls: 0,
      week_start_date: now.toISOString().split('T')[0],
      weekly_reset_at: now.toISOString()
    }).eq('id', 1);

    return 0;
  }
  return settings.current_week_calls;
}

// ── Get next bars to call ──
async function getNextBars(limit) {
  // First: bars never called this week
  const { data: uncalled } = await supabase
    .from('bars')
    .select('id, name, phone, city, call_count')
    .not('phone', 'is', null)
    .is('last_called_at', null)
    .limit(limit);

  if (uncalled && uncalled.length >= limit) return uncalled;

  // Fallback: oldest called bars
  const needed = limit - (uncalled?.length || 0);
  const { data: oldest } = await supabase
    .from('bars')
    .select('id, name, phone, city, call_count')
    .not('phone', 'is', null)
    .not('last_called_at', 'is', null)
    .order('last_called_at', { ascending: true })
    .limit(needed);

  return [...(uncalled || []), ...(oldest || [])];
}

// ── Make Vapi call ──
async function makeCall(bar) {
  const res = await axios.post(
    'https://api.vapi.ai/call/phone',
    {
      customer: { number: bar.phone, name: bar.name },
      assistantId: ASSISTANT_ID,
      phoneNumberId: PHONE_ID,
      metadata: { bar_id: bar.id, bar_name: bar.name, city: bar.city }
    },
    { headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ── Main handler ──
module.exports = async function handler(req, res) {
  try {
    const { data: settings } = await supabase
      .from('campaign_settings')
      .select('*')
      .eq('id', 1)
      .single();

    // Campaign off
    if (!settings.is_active) {
      return res.json({ status: 'inactive' });
    }

    // Time window check
    const italy = getItalyTime();
    if (!isContactWindow(italy)) {
      return res.json({
        status: 'outside_window',
        italy_time: `${italy.hour}:${String(italy.minute).padStart(2,'0')}`
      });
    }

    // Week reset check
    const currentCalls = await handleWeekReset(settings);

    // Weekly limit check — notify if complete
    if (currentCalls >= settings.calls_per_week) {
      // Update notification flag
      await supabase.from('campaign_settings').update({
        week_complete_notified: true
      }).eq('id', 1);

      return res.json({
        status: 'week_complete',
        message: `300 calls complete for this week. Will reset on ${new Date(new Date(settings.week_start_date).getTime() + 7*86400000).toDateString()}`,
        calls: currentCalls
      });
    }

    // Calls per slot: 300/week ÷ ~12 slots = 25 per slot
    const remaining = settings.calls_per_week - currentCalls;
    const batchSize = Math.min(25, remaining);

    const bars = await getNextBars(batchSize);
    if (!bars || bars.length === 0) {
      return res.json({ status: 'no_bars' });
    }

    let success = 0, failed = 0;

    for (const bar of bars) {
      try {
        const result = await makeCall(bar);
        await supabase.from('bars').update({
          last_called_at: new Date().toISOString(),
          call_count: (bar.call_count || 0) + 1,
          vapi_call_id: result.id
        }).eq('id', bar.id);
        success++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`Call failed: ${bar.name}`, err.message);
        failed++;
      }
    }

    // Update weekly counter
    const newTotal = currentCalls + success;
    await supabase.from('campaign_settings').update({
      current_week_calls: newTotal,
      last_called_at: new Date().toISOString(),
      week_complete_notified: newTotal >= settings.calls_per_week ? true : false
    }).eq('id', 1);

    return res.json({
      status: 'success',
      calls_made: success,
      calls_failed: failed,
      week_total: newTotal,
      week_limit: settings.calls_per_week,
      italy_time: `${italy.hour}:${String(italy.minute).padStart(2,'0')}`
    });

  } catch (err) {
    console.error('Campaign error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}