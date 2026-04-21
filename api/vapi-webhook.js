// api/vapi-webhook.js
// Vapi calls this when a call ends — saves price to Supabase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const messageType = body?.message?.type;

    // Only process end-of-call reports
    if (messageType !== 'end-of-call-report') {
      return res.status(200).json({ received: true, type: messageType });
    }

    const transcript  = body?.message?.transcript || '';
    const metadata    = body?.message?.call?.assistantOverrides?.metadata ||
                        body?.message?.call?.metadata || {};
    const barId       = metadata?.bar_id || null;
    const barName     = metadata?.bar_name || 'Unknown';
    const duration    = body?.message?.durationSeconds || 0;

    console.log(`Call ended — Bar: ${barName}, Duration: ${duration}s`);
    console.log(`Transcript: ${transcript.slice(0, 200)}`);

    // Extract price from transcript
    const price = extractPrice(transcript);
    console.log(`Price found: ${price ? '€' + price : 'none'}`);

    // Save price if found
    if (price && barId) {
      const { error: priceError } = await supabase.from('prices').insert({
        bar_id: barId,
        price,
        source: 'ai_call',
        transcript,
        called_at: new Date().toISOString()
      });

      if (priceError) {
        console.error('Price save error:', priceError.message);
      } else {
        console.log(`✅ Price saved: €${price} for ${barName}`);
      }
    }

    // Update bar — increment call_count
    if (barId) {
      // First get current call_count
      const { data: bar } = await supabase
        .from('bars')
        .select('call_count')
        .eq('id', barId)
        .single();

      const newCount = (bar?.call_count || 0) + 1;

      await supabase.from('bars').update({
        last_called_at: new Date().toISOString(),
        call_count: newCount
      }).eq('id', barId);
    }

    return res.status(200).json({
      success: true,
      bar: barName,
      price: price || null,
      duration
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Extract price from Italian transcript ──
function extractPrice(transcript) {
  if (!transcript) return null;
  const t = transcript.toLowerCase();

  // Numeric: 4.50, 4,50, €4.50, 5 euro, €6
  const decimal = t.match(/(?:€\s*)?(\d+)[.,](\d{1,2})\s*(?:euro|€)?/);
  if (decimal) {
    const val = parseFloat(`${decimal[1]}.${decimal[2]}`);
    if (val >= 1 && val <= 20) return val;
  }

  const whole = t.match(/(?:€\s*)?(\d+)\s*(?:euro|€)/);
  if (whole) {
    const val = parseFloat(whole[1]);
    if (val >= 1 && val <= 20) return val;
  }

  // Italian word numbers
  const wordMap = {
    'tre': 3, 'quattro': 4, 'cinque': 5, 'sei': 6,
    'sette': 7, 'otto': 8, 'nove': 9, 'dieci': 10
  };

  for (const [word, val] of Object.entries(wordMap)) {
    if (t.includes(word + ' e mezzo')) return val + 0.5;
    if (t.includes(word + ' euro')) return val;
    if (t.includes(word + ' e cinquanta')) return val + 0.5;
  }

  return null;
}
