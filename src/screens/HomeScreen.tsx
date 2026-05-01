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
import { supabase } from '../lib/supabase';

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
  session_type: string;
  title: string | null;
  sections: Section[];
  wod_results: { wod_name: string | null; score_type: string | null; score_value: string | null }[];
  notes: string | null;
};

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
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages, parsing]);

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  async function saveWorkout(parsed: ParsedWorkout, rawText: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Ensure user row exists
    await supabase.from('users').upsert({ id: user.id }, { onConflict: 'id' });

    // Create session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        date: new Date().toISOString().split('T')[0],
        type: parsed.session_type,
        raw_user_text: rawText,
      })
      .select()
      .single();

    if (sessionError || !session) return;

    // Save all exercises from all sections, excluding warm-up sections
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

    // Save WOD results
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

    const userMessage: Message = {
      id: Date.now().toString(),
      text: input.trim(),
      sender: 'user',
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setParsing(true);

    try {
      const { data, error } = await supabase.functions.invoke('parse-workout', {
        body: { text: userMessage.text },
      });

      setParsing(false);

      let replyText: string;
      if (error || !data || data.error) {
        replyText = 'Something went wrong. Try again.';
      } else if (data.intent === 'recall' || data.intent === 'convert') {
        replyText = data.answer;
      } else {
        // intent === 'log'
        saveWorkout(data, userMessage.text);
        replyText = formatParsedWorkout(data);
      }

      const replyMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: replyText,
        sender: 'chalk',
      };
      setMessages(prev => [...prev, replyMessage]);
    } catch (err) {
      setParsing(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>chalk</Text>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {/* Messages */}
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

      {/* Input bar */}
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
