import { Ionicons } from "@expo/vector-icons";
import { Stack, router } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const PRIMARY = "#b19870";
const BG = "#0d0b08";

export default function NotFoundScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
        <Ionicons name="compass-outline" size={48} color={PRIMARY} />
        <Text style={styles.title}>This screen doesn&apos;t exist.</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => router.replace("/")}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Go to home screen</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: BG,
    gap: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "white",
    textAlign: "center",
  },
  button: {
    marginTop: 8,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    backgroundColor: PRIMARY,
  },
  buttonText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "white",
  },
});
