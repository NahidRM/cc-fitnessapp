const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { text } = await req.json();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `Parse this workout text into structured JSON. Return ONLY valid JSON, no explanation.

The input may be:
- A structured coach program (with labeled sections like "A) Warm Up", "B) Main Work")
- Casual post-workout text (e.g. "did 5x3 back squat at 100kg, felt good")
- A mix of both

The JSON must follow this exact shape:
{
  "session_type": "strength" | "wod" | "mixed" | "other",
  "title": string | null,
  "sections": [
    {
      "label": string | null,
      "title": string | null,
      "exercises": [
        { "name": string, "sets": number | null, "reps": number | null, "weight_kg": number | null, "notes": string | null }
      ]
    }
  ],
  "wod_results": [
    { "wod_name": string | null, "score_type": "time" | "rounds" | "reps" | "weight" | null, "score_value": string | null }
  ],
  "notes": string | null
}

Rules:
- "title" is the overall session title if one exists (e.g. "Training Day 06"), otherwise null.
- For structured input with labeled sections (A, B, C...), create one section per label.
- For casual input with no sections, put all exercises in a single section with label: null and title: null.
- Convert all weights to kg (1 lb = 0.4536 kg). Round to 2 decimal places.
- If no exercises, return empty array. Same for wod_results.
- "notes" on an exercise is for qualifiers like "each leg", "60% effort", "tempo", etc.
- Top-level "notes" is for anything that doesn't fit elsewhere.

Workout text:
${text}`,
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ parseError: 'Anthropic API error', detail: data }), {
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    const raw = data.content[0].text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(raw);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ parseError: String(err) }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
