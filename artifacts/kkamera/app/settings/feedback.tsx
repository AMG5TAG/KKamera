import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Platform, Alert, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSubmitFeedback } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const TYPES = [
  { value: "bug", label: "Bug Report", icon: "bug-outline", desc: "Something isn't working correctly" },
  { value: "feature", label: "Feature Request", icon: "bulb-outline", desc: "I'd love to see this in KKamera" },
  { value: "other", label: "General Feedback", icon: "chatbubble-outline", desc: "Anything else on your mind" },
];

export default function FeedbackScreen() {
  const insets = useSafeAreaInsets();
  const [type, setType] = useState<"bug" | "feature" | "other">("bug");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const submitMutation = useSubmitFeedback();

  const handleSubmit = async () => {
    if (message.trim().length < 10) {
      Alert.alert("Too short", "Please provide a bit more detail (at least 10 characters).");
      return;
    }
    try {
      await submitMutation.mutateAsync({ data: { type, message: message.trim() } });
      setSent(true);
      setMessage("");
    } catch {
      Alert.alert("Error", "Could not submit feedback. Please try again.");
    }
  };

  if (sent) {
    return (
      <View style={[styles.successWrap, { backgroundColor: BG }]}>
        <TouchableOpacity style={[styles.backBtn, { alignSelf: "flex-start" }]} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={PRIMARY} />
          <Text style={styles.backBtnText}>Back</Text>
        </TouchableOpacity>
        <Ionicons name="checkmark-circle" size={64} color={PRIMARY} />
        <Text style={styles.successTitle}>Thank You!</Text>
        <Text style={styles.successText}>Your feedback has been submitted. We read every message and use it to make KKamera better.</Text>
        <TouchableOpacity style={styles.doneBtn} onPress={() => setSent(false)}>
          <Text style={styles.doneBtnText}>Send Another</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
      <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      <Text style={styles.backBtnText}>Back</Text>
    </TouchableOpacity>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }} showsVerticalScrollIndicator={false}>
      <Text style={styles.intro}>
        Found a bug? Have a great idea? Just want to share a thought? We'd love to hear from you.
      </Text>

      <Text style={styles.sectionTitle}>Type of Feedback</Text>
      {TYPES.map(t => (
        <TouchableOpacity key={t.value} style={[styles.typeCard, type === t.value && styles.typeCardSelected]} onPress={() => setType(t.value as any)}>
          <Ionicons name={t.icon as any} size={22} color={type === t.value ? PRIMARY : "#888"} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.typeLabel, type === t.value && { color: PRIMARY }]}>{t.label}</Text>
            <Text style={styles.typeDesc}>{t.desc}</Text>
          </View>
          {type === t.value && <Ionicons name="checkmark-circle" size={20} color={PRIMARY} />}
        </TouchableOpacity>
      ))}

      <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Your Message</Text>
      <Text style={styles.hint}>? The more detail you provide, the better we can help.</Text>
      <TextInput
        style={styles.messageInput}
        placeholder={
          type === "bug"
            ? "Describe what happened and what you expected to happen..."
            : type === "feature"
            ? "Describe the feature you'd like and why it would help you..."
            : "Share your thoughts..."
        }
        placeholderTextColor="#555"
        multiline
        numberOfLines={6}
        value={message}
        onChangeText={setMessage}
        textAlignVertical="top"
      />
      <Text style={styles.charCount}>{message.length} characters</Text>

      <TouchableOpacity
        style={[styles.submitBtn, (submitMutation.isPending || message.length < 10) && styles.btnDisabled]}
        onPress={handleSubmit}
        disabled={submitMutation.isPending || message.length < 10}
      >
        {submitMutation.isPending ? <ActivityIndicator color="white" /> : (
          <>
            <Ionicons name="send-outline" size={18} color="white" />
            <Text style={styles.submitBtnText}>Send Feedback</Text>
          </>
        )}
      </TouchableOpacity>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  intro: { fontSize: 14, color: "#aaa", fontFamily: "Inter_400Regular", lineHeight: 20, marginBottom: 20 },
  sectionTitle: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 },
  typeCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  typeCardSelected: { borderColor: PRIMARY, backgroundColor: "rgba(177,152,112,0.08)" },
  typeLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  typeDesc: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular" },
  hint: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 10 },
  messageInput: { backgroundColor: CARD, borderRadius: 12, padding: 14, color: "white", fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", minHeight: 130 },
  charCount: { fontSize: 11, color: "#555", fontFamily: "Inter_400Regular", textAlign: "right", marginTop: 4, marginBottom: 20 },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16 },
  btnDisabled: { opacity: 0.5 },
  submitBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  successWrap: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center", padding: 40 },
  successTitle: { fontSize: 28, fontFamily: "Inter_700Bold", color: "white", marginTop: 16, marginBottom: 12 },
  successText: { fontSize: 15, color: "#aaa", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22, marginBottom: 32 },
  doneBtn: { paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)" },
  doneBtnText: { fontSize: 14, fontFamily: "Inter_500Medium", color: PRIMARY },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  backBtnText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
});
