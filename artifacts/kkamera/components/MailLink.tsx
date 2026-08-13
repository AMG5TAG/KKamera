import React from "react";
import { Text, StyleSheet, Linking } from "react-native";

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
    // Rejects when no mail client is registered (common on desktop web and on
    // simulators) — swallow it rather than surface an unhandled rejection.
    Linking.openURL(url).catch(() => {});
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

const styles = StyleSheet.create({
  link: { color: PRIMARY, textDecorationLine: "underline" },
});
