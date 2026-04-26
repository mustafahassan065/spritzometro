// api/campaign.js — Vercel Serverless Function
// Runs automatically via cron — no toggle needed

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const PHONE_ID     = process.env.VAPI_PHONE_ID;
const GMAPS_KEY    = process.env.GOOGLE_MAPS_API_KEY;

const CITIES = ['Milan', 'Rome', 'Naples', 'Venice', 'Florence'];

// ── Italian time (correct DST handling) ──
function getItalyTime() {
  const now = new Date();
  const italyStr = now.toLocaleString('en-US', { timeZone: 'Europe/Rome' });
  const italy = new Date(italyStr);
  return {
    hour: italy.getHours(),
    minute: italy.getMinutes(),
    day: italy.getDay(), // 0=Sun, 1=Mon...6=Sat
    decimal: italy.getHours() + italy.getMinutes() / 60
  };
}

// ── Contact window — exactly as per client PDF ──
function isContactWindow(it) {
  const { day, decimal } = it;
  // Mon-Thu: 10:00-11:30 and 15:30-17:30
  if (day >= 1 && day <= 4)
    return (decimal >= 10.0 && decimal < 11.5) || (decimal >= 15.5 && decimal < 17.5);
  // Friday: 10:00-11:30 and 15:00-16:30
  if (day === 5)
    return (decimal >= 10.0 && decimal < 11.5) || (decimal >= 15.0 && decimal < 16.5);
  // Saturday: 10:30-11:30 only
  if (day === 6)
    return decimal >= 10.5 && decimal < 11.5;
  // Sunday: 11:00-12:00 only
  if (day === 0)
    return decimal >= 11.0 && decimal < 12.0;
  return false;
}

// ── Week reset — every 7 days reset all bars for re-calling ──
async function handleWeekReset(settings) {
  const weekStart = new Date(settings.week_start_date);
  const now = new Date();
  const daysDiff = Math.floor((now - weekStart) / 86400000);

  if (daysDiff >= 7) {
    console.log('New week — resetting all bars for re-calling');

    // Reset last_called_at for all bars so they get called again
    await supabase
      .from('bars')
      .update({ last_called_at: null })
      .neq('id', '00000000-0000-0000-0000-000000000000');

    // Remove bars that never answered (3+ calls, no price)
    const { data: failedBars } = await supabase
      .from('bars')
      .select('id')
      .gte('call_count', 3);

    if (failedBars && failedBars.length > 0) {
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

      // Fetch replacement bars from Google Maps
      for (const city of CITIES) {
        try {
          const res = await axios.get(
            'https://maps.googleapis.com/maps/api/place/textsearch/json',
            { params: { query: `bar aperitivo ${city} Italy`, key: GMAPS_KEY, language: 'it' } }
          );
          for (const place of (res.data.results || []).slice(0, 5)) {
            const det = await axios.get(
              'https://maps.googleapis.com/maps/api/place/details/json',
              { params: { place_id: place.place_id, fields: 'name,formatted_phone_number,formatted_address,geometry', key: GMAPS_KEY } }
            );
            const d = det.data.result;
            if (!d.formatted_phone_number) continue;
            await supabase.from('bars').insert({
              name: d.name, address: d.formatted_address, city,
              phone: d.formatted_phone_number,
              latitude: d.geometry?.location?.lat,
              longitude: d.geometry?.location?.lng,
              place_id: place.place_id, call_count: 0, last_called_at: null
            }).select();
            await new Promise(r => setTimeout(r, 200));
          }
        } catch (e) { console.error(`Fetch error ${city}:`, e.message); }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Reset weekly counter
    await supabase.from('campaign_settings').update({
      current_week_calls: 0,
      week_start_date: now.toISOString().split('T')[0],
      week_complete_notified: false,
      weekly_reset_at: now.toISOString()
    }).eq('id', 1);

    return 0;
  }
  return settings.current_week_calls;
}

// ── Get next bars to call ──
async function getNextBars(limit) {
  // First: uncalled bars
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

// ── Make Vapi call with correct Italian phone format ──
async function makeCall(bar) {
  let phone = bar.phone.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  if (!phone.startsWith('+')) phone = '+39' + phone;

  const res = await axios.post(
    'https://api.vapi.ai/call/phone',
    {
      customer: { number: phone, name: bar.name },
      assistantId: ASSISTANT_ID,
      phoneNumberId: PHONE_ID,
      assistantOverrides: {
        metadata: { bar_id: bar.id, bar_name: bar.name, city: bar.city }
      }
    },
    { headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ── Main handler ──
export default async function handler(req, res) {
  try {
    // Get campaign settings
    const { data: settings } = await supabase
      .from('campaign_settings')
      .select('*')
      .eq('id', 1)
      .single();

    // Check Italian time window — no is_active check needed
    const italy = getItalyTime();
    if (!isContactWindow(italy)) {
      return res.json({
        status: 'outside_window',
        italy_time: `${italy.hour}:${String(italy.minute).padStart(2,'0')}`,
        day: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][italy.day]
      });
    }

    // Handle week reset
    const currentCalls = await handleWeekReset(settings);

    // Weekly limit reached — wait for reset
    if (currentCalls >= settings.calls_per_week) {
      await supabase.from('campaign_settings')
        .update({ week_complete_notified: true })
        .eq('id', 1);

      return res.json({
        status: 'week_complete',
        calls: currentCalls,
        limit: settings.calls_per_week
      });
    }

    // Batch size: 300/week ÷ ~12 slots = 25 per slot
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
        await new Promise(r => setTimeout(r, 8000)); // 8s between calls — avoid rate limit
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
      week_complete_notified: newTotal >= settings.calls_per_week
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
