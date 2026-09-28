import React from "react";
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from "react-native-keyboard-controller";
import { Platform, ScrollView, ScrollViewProps, View, ViewProps } from "react-native";

// Requires <KeyboardProvider> at the app root (app/_layout.tsx). On native,
// react-native-keyboard-controller scrolls the focused input above the keyboard
// on both iOS and Android (edge-to-edge); on web the browser handles it, so a
// plain ScrollView is used.

type Props = KeyboardAwareScrollViewProps & ScrollViewProps;

export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = "handled",
  bottomOffset = 24,
  ...props
}: Props) {
  if (Platform.OS === "web") {
    return (
      <ScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props}>
        {children}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      bottomOffset={bottomOffset}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

/**
 * Pads its content by the keyboard height so a footer pinned below a scroll
 * view (e.g. a "Next" button) stays reachable while the keyboard is open.
 */
export function KeyboardAvoidingViewCompat({ children, ...props }: ViewProps) {
  if (Platform.OS === "web") {
    return <View {...props}>{children}</View>;
  }
  return (
    <KeyboardAvoidingView behavior="padding" {...props}>
      {children}
    </KeyboardAvoidingView>
  );
}
