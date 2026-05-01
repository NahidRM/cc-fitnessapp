import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function callClaude(prompt: string): Promise<string> {
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
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data.content[0].text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
}

function classifyPrompt(text: string): string {
  return `Classify this message and return ONLY valid JSON. No explanation.

The message is one of four intents:
- "log_coach": a structured workout plan from a coach (has labeled sections like A/B/C, uses percentages or prescribed weights, imperative/future tone, often includes warm-up)
- "log_performance": the user's actual post-workout update (casual, past tense, personal — like what they'd text their coach after training)
- "recall": user is asking about their past workout history (e.g. "what did I squat last time?", "what weight did I use for 5 reps on bench?")
- "convert": user is asking to convert a unit (e.g. "convert 100kg to lbs", "how much is 225 lbs in kg?")

For "log_coach" and "log_performance", return this shape (only the intent value differs):
{
  "intent": "log_coach" | "log_performance",
  "session_type": "strength" | "wod" | "mixed" | "other",
  "title": string | null,
  "sections": [
    {
      "label": string | null,
      "title": string | null,
      "exercises": [
        { "name": string, "sets": number | null, "reps": number | null, "weight_kg": number | null, "effort_pct": number | null, "notes": string | null }
      ]
    }
  ],
  "wod_results": [
    { "wod_name": string | null, "score_type": "time" | "rounds" | "reps" | "weight" | null, "score_value": string | null }
  ],
  "notes": string | null
}

For "recall", return:
{
  "intent": "recall",
  "exercise_name": string,
  "reps_filter": number | null
}

For "convert", return:
{
  "intent": "convert",
  "answer": string
}

Rules for log intents:
- Convert all weights to kg (1 lb = 0.4536 kg), round to 2 decimal places.
- "effort_pct" is a number (e.g. 80 for 80%), only when explicitly mentioned. Otherwise null.
- "notes" on an exercise is for qualifiers like "each leg", "tempo", "pause", etc. Do not put effort % in notes.
- For structured input with labeled sections (A, B, C...), one section per label.
- For casual input, single section with label: null and title: null.

Message:
${text}`;
}

function recallPrompt(question: string, exercises: unknown[]): string {
  return `The user asked: "${question}"

Here is their exercise history (most recent first):
${JSON.stringify(exercises, null, 2)}

Answer in a friendly, conversational way. Be specific — include the date, sets, reps, weight (in kg), and effort % if available. If no history exists, say so. Keep it short (2-4 lines max).`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { text } = await req.json();

    const raw = await callClaude(classifyPrompt(text));
    const result = JSON.parse(raw);

    // Unit conversion — Claude already answered, just return it
    if (result.intent === 'convert') {
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    // Workout log (coach plan or user performance) — return parsed data for the frontend
    if (result.intent === 'log_coach' || result.intent === 'log_performance') {
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    // Recall — query the DB, then ask Claude to format a natural language answer
    if (result.intent === 'recall') {
      const authHeader = req.headers.get('Authorization');
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader! } } }
      );

      const { data: exercises } = await supabase
        .from('exercises')
        .select('name, sets, reps, weight_kg, effort_pct, notes, sessions(date)')
        .ilike('name', `%${result.exercise_name}%`)
        .limit(20);

      // Sort by session date descending (most recent first)
      const sorted = (exercises ?? []).sort((a: any, b: any) => {
        const dateA = a.sessions?.date ?? '';
        const dateB = b.sessions?.date ?? '';
        return dateB.localeCompare(dateA);
      });

      const answer = await callClaude(recallPrompt(text, sorted));

      return new Response(JSON.stringify({ intent: 'recall', answer }), {
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    throw new Error('Unknown intent: ' + result.intent);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
      status: 500,
    });
  }
});
