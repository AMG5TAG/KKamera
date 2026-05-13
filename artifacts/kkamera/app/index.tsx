import { Redirect } from "expo-router";
import React from "react";
import { View, ActivityIndicator } from "react-native";
import { useAuth } from "@/contexts/AuthContext";

export default function IndexScreen() {
  const { isLoading, isAuthenticated, hasCompletedWizard } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0d0b08", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#b19870" size="large" />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <Redirect href="/auth/login" />;
  }

  if (!hasCompletedWizard) {
    return <Redirect href="/wizard" />;
  }

  return <Redirect href="/camera" />;
}
