import { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

const ACTIVE_SESSION_KEY = 'chalk_active_session';

type Message = {
  id: string;
  text: string;
  sender: 'user' | 'chalk';
};

type Exercise = {
  name: string;
  sets: number | null;
  reps: number | null;
  weight_kg: number | null;
  effort_pct: number | null;
  notes: string | null;
};

type Section = {
  label: string | null;
  title: string | null;
  exercises: Exercise[];
};

type ParsedWorkout = {
  intent: 'log_coach' | 'log_performance';
  session_type: string;
  title: string | null;
  sections: Section[];
  wod_results: { wod_name: string | null; score_type: string | null; score_value: string | null }[];
  notes: string | null;
};

type ActiveSession = {
  id: string;
  date: string; // YYYY-MM-DD
};

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function formatExercise(ex: Exercise): string {
  let line = `• ${ex.name}`;
  if (ex.sets && ex.reps) line += ` — ${ex.sets}×${ex.reps}`;
  if (ex.weight_kg) line += ` @ ${ex.weight_kg}kg`;
  if (ex.effort_pct) line += ` (${ex.effort_pct}% effort)`;
  if (ex.notes) line += ` [${ex.notes}]`;
  return line;
}

function formatParsedWorkout(parsed: ParsedWorkout): string {
  const lines: string[] = [];

  if (parsed.title) lines.push(parsed.title);

  const sections = parsed.sections ?? [];
  const isSectioned = sections.some(s => s.label || s.title);

  for (const section of sections) {
    if (lines.length > 0) lines.push('');
    if (isSectioned) {
      const heading = [section.label, section.title].filter(Boolean).join(' — ');
      if (heading) lines.push(heading);
    }
    for (const ex of section.exercises) {
      lines.push(formatExercise(ex));
    }
  }

  if (parsed.wod_results?.length > 0) {
    lines.push('');
    for (const wod of parsed.wod_results) {
      let line = `• ${wod.wod_name ?? 'WOD'}`;
      if (wod.score_value) line += ` — ${wod.score_value}`;
      lines.push(line);
    }
  }

  if (parsed.notes) {
    lines.push('');
    lines.push(parsed.notes);
  }

  return lines.join('\n');
}

export default function HomeScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [parsing, setParsing] = useState(false);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages, parsing]);

  // On mount: load active session and check if it's stale
  useEffect(() => {
    async function checkActiveSession() {
      const stored = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
      if (!stored) return;

      const session: ActiveSession = JSON.parse(stored);
      setActiveSession(session);

      if (session.date < today()) {
        addChalkMessage(
          `Looks like you didn't log your performance from ${session.date}. Send me your numbers when you're ready, or say "skip" to move on.`
        );
      }
    }
    checkActiveSession();
  }, []);

  function addChalkMessage(text: string) {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      text,
      sender: 'chalk',
    }]);
  }

  async function persistActiveSession(session: ActiveSession | null) {
    setActiveSession(session);
    if (session) {
      await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
    } else {
      await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  async function saveCoachWorkout(parsed: ParsedWorkout, rawText: string): Promise<string | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    await supabase.from('users').upsert({ id: user.id }, { onConflict: 'id' });

    const { data: session, error } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        date: today(),
        type: parsed.session_type,
        raw_coach_text: rawText,
      })
      .select()
      .single();

    if (error || !session) return null;

    const isWarmUp = (s: Section) => s.title?.toLowerCase().includes('warm up') ?? false;
    const exercises = (parsed.sections ?? []).filter(s => !isWarmUp(s)).flatMap(s => s.exercises).map(ex => ({
      session_id: session.id,
      name: ex.name,
      sets: ex.sets,
      reps: ex.reps,
      weight_kg: ex.weight_kg,
      effort_pct: ex.effort_pct,
      notes: ex.notes,
    }));

    if (exercises.length > 0) {
      await supabase.from('exercises').insert(exercises);
    }

    const wods = (parsed.wod_results ?? []).map(w => ({
      session_id: session.id,
      wod_name: w.wod_name,
      score_type: w.score_type,
      score_value: w.score_value,
    }));

    if (wods.length > 0) {
      await supabase.from('wod_results').insert(wods);
    }

    return session.id;
  }

  async function attachPerformance(sessionId: string, parsed: ParsedWorkout, rawText: string) {
    await supabase.from('sessions').update({ raw_user_text: rawText }).eq('id', sessionId);

    const isWarmUp = (s: Section) => s.title?.toLowerCase().includes('warm up') ?? false;
    const exercises = (parsed.sections ?? []).filter(s => !isWarmUp(s)).flatMap(s => s.exercises).map(ex => ({
      session_id: sessionId,
      name: ex.name,
      sets: ex.sets,
      reps: ex.reps,
      weight_kg: ex.weight_kg,
      effort_pct: ex.effort_pct,
      notes: ex.notes,
    }));

    if (exercises.length > 0) {
      await supabase.from('exercises').insert(exercises);
    }

    const wods = (parsed.wod_results ?? []).map(w => ({
      session_id: sessionId,
      wod_name: w.wod_name,
      score_type: w.score_type,
      score_value: w.score_value,
    }));

    if (wods.length > 0) {
      await supabase.from('wod_results').insert(wods);
    }
  }

  async function saveStandalonePerformance(parsed: ParsedWorkout, rawText: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from('users').upsert({ id: user.id }, { onConflict: 'id' });

    const { data: session, error } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        date: today(),
        type: parsed.session_type,
        raw_user_text: rawText,
      })
      .select()
      .single();

    if (error || !session) return;

    const isWarmUp = (s: Section) => s.title?.toLowerCase().includes('warm up') ?? false;
    const exercises = (parsed.sections ?? []).filter(s => !isWarmUp(s)).flatMap(s => s.exercises).map(ex => ({
      session_id: session.id,
      name: ex.name,
      sets: ex.sets,
      reps: ex.reps,
      weight_kg: ex.weight_kg,
      effort_pct: ex.effort_pct,
      notes: ex.notes,
    }));

    if (exercises.length > 0) {
      await supabase.from('exercises').insert(exercises);
    }

    const wods = (parsed.wod_results ?? []).map(w => ({
      session_id: session.id,
      wod_name: w.wod_name,
      score_type: w.score_type,
      score_value: w.score_value,
    }));

    if (wods.length > 0) {
      await supabase.from('wod_results').insert(wods);
    }
  }

  async function handleSend() {
    if (!input.trim() || parsing) return;

    const text = input.trim();
    setInput('');

    const userMessage: Message = { id: Date.now().toString(), text, sender: 'user' };
    setMessages(prev => [...prev, userMessage]);

    // Handle "skip" — clear the stale session without logging
    if (text.toLowerCase() === 'skip') {
      await persistActiveSession(null);
      addChalkMessage("No problem, moving on.");
      return;
    }

    setParsing(true);

    try {
      const { data, error } = await supabase.functions.invoke('parse-workout', {
        body: { text },
      });

      setParsing(false);

      if (error || !data || data.error) {
        addChalkMessage('Something went wrong. Try again.');
        return;
      }

      if (data.intent === 'recall' || data.intent === 'convert') {
        addChalkMessage(data.answer);
        return;
      }

      if (data.intent === 'log_coach') {
        const sessionId = await saveCoachWorkout(data, text);
        if (sessionId) {
          await persistActiveSession({ id: sessionId, date: today() });
          addChalkMessage(`Got it. Send me your numbers when you're done.`);
        } else {
          addChalkMessage('Could not save that. Try again.');
        }
        return;
      }

      if (data.intent === 'log_performance') {
        if (activeSession) {
          // Attach to the existing session (coach workout or same-day session)
          await attachPerformance(activeSession.id, data, text);
          await persistActiveSession(null);
          addChalkMessage(`Logged. Nice work.\n\n${formatParsedWorkout(data)}`);
        } else {
          // No coach plan on record — save as a standalone session
          await saveStandalonePerformance(data, text);
          addChalkMessage(formatParsedWorkout(data));
        }
        return;
      }

      addChalkMessage('Something went wrong. Try again.');
    } catch {
      setParsing(false);
      addChalkMessage('Something went wrong. Try again.');
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.logo}>chalk</Text>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.messageList}
        renderItem={({ item }) => (
          <View style={[
            styles.bubble,
            item.sender === 'user' ? styles.userBubble : styles.chalkBubble,
          ]}>
            <Text style={[
              styles.bubbleText,
              item.sender === 'user' ? styles.userText : styles.chalkText,
            ]}>
              {item.text}
            </Text>
          </View>
        )}
        ListFooterComponent={
          parsing ? (
            <View style={styles.chalkBubble}>
              <ActivityIndicator color="#00f5d4" size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>Your workouts will appear here.</Text>
        }
      />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="Drop your workout here..."
            placeholderTextColor="#555"
            value={input}
            onChangeText={setInput}
            multiline
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSend} disabled={parsing}>
            <Text style={styles.sendText}>▲</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  logo: {
    fontSize: 24,
    fontWeight: '700',
    color: '#00f5d4',
    letterSpacing: 3,
  },
  signOut: {
    color: '#555',
    fontSize: 14,
  },
  messageList: {
    padding: 16,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  emptyText: {
    color: '#333',
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  userBubble: {
    backgroundColor: '#00f5d4',
    alignSelf: 'flex-end',
  },
  chalkBubble: {
    backgroundColor: '#2a2a2a',
    alignSelf: 'flex-start',
    maxWidth: '80%',
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 22,
  },
  userText: {
    color: '#1a1a1a',
  },
  chalkText: {
    color: '#fff',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    color: '#fff',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: '#00f5d4',
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: {
    color: '#1a1a1a',
    fontSize: 18,
    fontWeight: '700',
  },
});
