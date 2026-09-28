import React from "react";
import { Alert, Linking, Platform, Share, StyleSheet, Text } from "react-native";

const PRIMARY = "#b19870";

/**
 * A tappable email address for use inside body copy.
 *
 * Renders as a nested <Text> so it flows inline with the surrounding paragraph
 * and inherits its line height — a Touchable would break the text run onto its
 * own line.
 */
export function MailLink({ address, subject }: { address: string; subject?: string }) {
  const open = () => {
    const url = subject
      ? `mailto:${address}?subject=${encodeURIComponent(subject)}`
      : `mailto:${address}`;
    // Rejects when no mail client is registered (common on desktop web, on
    // simulators and on devices without the Mail app) — show the address so the
    // user can still reach us instead of the tap silently doing nothing.
    Linking.openURL(url).catch(() => showAddress(address));
  };

  return (
    <Text
      style={styles.link}
      onPress={open}
      accessibilityRole="link"
      accessibilityLabel={`Email ${address}`}
    >
      {address}
    </Text>
  );
}

function showAddress(address: string) {
  if (Platform.OS === "web") {
    // Alert is a no-op on react-native-web; a prompt shows the address selected
    // and ready to copy.
    if (typeof window !== "undefined") window.prompt("No email app found. Copy this address:", address);
    return;
  }
  Alert.alert("No email app found", `You can reach us at:\n\n${address}`, [
    { text: "Share / Copy", onPress: () => { Share.share({ message: address }).catch(() => {}); } },
    { text: "OK", style: "cancel" },
  ]);
}

const styles = StyleSheet.create({
  link: { color: PRIMARY, textDecorationLine: "underline" },
});
