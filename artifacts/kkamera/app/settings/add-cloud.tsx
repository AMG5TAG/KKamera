import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Platform, Alert, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { useCreateCloudConnection, getListCloudConnectionsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { API_BASE_URL } from "@/lib/config";

WebBrowser.maybeCompleteAuthSession();

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const BASE_URL = API_BASE_URL;

const CLOUD_TYPES = [
  {
    type: "googledrive", label: "Google Drive", icon: "google-drive", color: "#4285F4", set: "mci", oAuth: true,
    desc: "Connect via your Google account — no tokens to copy.",
  },
  {
    type: "onedrive", label: "OneDrive", icon: "microsoft-onedrive", color: "#0078D4", set: "mci", oAuth: true,
    desc: "Connect via your Microsoft account — one tap authorisation.",
  },
  {
    type: "dropbox", label: "Dropbox", icon: "dropbox", color: "#0061FF", set: "mci", oAuth: true,
    desc: "Connect via your Dropbox account — secure OAuth 2 flow.",
  },
  {
    type: "webdav", label: "WebDAV Server", icon: "server-outline", color: "#6B7280", set: "ion", oAuth: false,
    desc: "Connect to any WebDAV server (Nextcloud, ownCloud, etc.).",
  },
  {
    type: "ftp", label: "FTP / SFTP", icon: "folder-outline", color: "#8B5CF6", set: "ion", oAuth: false,
    desc: "Connect to an FTP server to upload photos and videos.",
  },
];

export default function AddCloudScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { token } = useAuth();
  const createMutation = useCreateCloudConnection();

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [uploadPath, setUploadPath] = useState("/KKamera");
  const [showPassword, setShowPassword] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<Record<string, boolean>>({});

  const selected = CLOUD_TYPES.find(t => t.type === selectedType);

  // Fetch which providers are configured on the server
  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/oauth/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data) return;
        const status: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(data)) {
          status[k] = (v as any).configured;
        }
        setOauthStatus(status);
      })
      .catch(() => {});
  }, [token]);

  const handleOAuth = async () => {
    if (!selectedType || !token) return;
    setOauthLoading(true);
    try {
      const platform = Platform.OS === "web" ? "web" : "native";
      const res = await fetch(`${BASE_URL}/api/oauth/${selectedType}/initiate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || selected?.label,
          platform,
          uploadPath: uploadPath || "/KKamera",
        }),
      });

      const data = await res.json() as any;

      if (!res.ok) {
        const msg = data?.message ?? "Failed to start OAuth";
        if (data?.missingEnv) {
          Alert.alert(
            "OAuth Not Configured",
            `${msg}\n\nAsk the app developer to add the required keys to the server environment.`,
          );
        } else {
          Alert.alert("Error", msg);
        }
        return;
      }

      const { authorizeUrl } = data as { authorizeUrl: string };

      if (Platform.OS === "web") {
        // Web: navigate same window — OAuth returns to /oauth-success
        window.location.href = authorizeUrl;
      } else {
        // Native: open in-app browser, intercept kkamera:// deep link
        const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, "kkamera://");
        if (result.type === "success" && result.url) {
          const url = new URL(result.url);
          const connectionId = url.searchParams.get("connectionId");
          const connName = url.searchParams.get("name");
          if (connectionId) {
            queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
            Alert.alert(
              "Connected!",
              `"${decodeURIComponent(connName ?? selected?.label ?? "Connection")}" added successfully.`,
              [{ text: "Done", onPress: () => router.back() }]
            );
          }
        } else if (result.type === "cancel") {
          // User cancelled — do nothing
        } else {
          Alert.alert("Auth Error", "OAuth flow did not complete. Please try again.");
        }
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message ?? "OAuth failed");
    } finally {
      setOauthLoading(false);
    }
  };

  const handleSaveFtpWebdav = async () => {
    if (!selectedType || !name.trim()) {
      Alert.alert("Missing Info", "Please choose a storage type and give it a name.");
      return;
    }
    if (!host.trim()) {
      Alert.alert("Missing Info", "Please enter the server host / URL.");
      return;
    }
    try {
      await createMutation.mutateAsync({
        data: {
          type: selectedType as any,
          name: name.trim(),
          host: host || null,
          port: port ? parseInt(port) : null,
          username: username || null,
          password: password || null,
          uploadPath: uploadPath || "/KKamera",
          oauthCode: null,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
      Alert.alert("Connection Added", `"${name}" saved.`, [{ text: "OK", onPress: () => router.back() }]);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.message || "Failed to add connection.");
    }
  };

  const isOAuthConfigured = selectedType ? oauthStatus[selectedType] !== false : true;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionTitle}>Choose Storage Type</Text>

        {CLOUD_TYPES.map(opt => (
          <TouchableOpacity
            key={opt.type}
            style={[styles.typeCard, selectedType === opt.type && styles.typeCardSelected]}
            onPress={() => { setSelectedType(opt.type); setName(opt.label); }}
          >
            <View style={[styles.typeIcon, { backgroundColor: opt.color + "22" }]}>
              {opt.set === "mci"
                ? <MaterialCommunityIcons name={opt.icon as any} size={24} color={opt.color} />
                : <Ionicons name={opt.icon as any} size={24} color={opt.color} />
              }
            </View>
            <View style={styles.typeInfo}>
              <Text style={styles.typeLabel}>{opt.label}</Text>
              <Text style={styles.typeDesc}>{opt.desc}</Text>
            </View>
            {selectedType === opt.type && <Ionicons name="checkmark-circle" size={20} color={PRIMARY} />}
          </TouchableOpacity>
        ))}

        {selectedType && selected && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Connection Details</Text>

            <Field label="Connection Name">
              <TextInput
                style={styles.input} value={name} onChangeText={setName}
                placeholder={`e.g. My ${selected.label}`} placeholderTextColor="#555"
              />
            </Field>

            <Field label="Upload Folder" hint="Where photos and videos will be saved">
              <TextInput
                style={styles.input} value={uploadPath} onChangeText={setUploadPath}
                placeholder="/KKamera" placeholderTextColor="#555" autoCapitalize="none"
              />
            </Field>

            {/* ── OAuth providers ── */}
            {selected.oAuth && (
              <>
                {!isOAuthConfigured && (
                  <View style={styles.warnCard}>
                    <Ionicons name="warning-outline" size={18} color="#f59e0b" />
                    <Text style={styles.warnText}>
                      OAuth for {selected.label} is not yet configured on this server.
                      The developer needs to add the API credentials.
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.oauthBtn, { backgroundColor: CLOUD_TYPES.find(t => t.type === selectedType)?.color ?? PRIMARY }, oauthLoading && { opacity: 0.6 }]}
                  onPress={handleOAuth}
                  disabled={oauthLoading}
                  activeOpacity={0.85}
                >
                  {oauthLoading
                    ? <ActivityIndicator color="white" />
                    : <>
                        {selected.set === "mci"
                          ? <MaterialCommunityIcons name={selected.icon as any} size={20} color="white" />
                          : <Ionicons name={selected.icon as any} size={20} color="white" />
                        }
                        <Text style={styles.oauthBtnText}>Connect with {selected.label}</Text>
                      </>
                  }
                </TouchableOpacity>

                <Text style={styles.oauthHint}>
                  You'll be taken to {selected.label}'s sign-in page and returned here automatically.
                </Text>
              </>
            )}

            {/* ── FTP / WebDAV ── */}
            {!selected.oAuth && (
              <>
                <Field
                  label="Server Host / URL"
                  hint={selectedType === "webdav" ? "e.g. https://cloud.example.com/dav" : "e.g. ftp.example.com"}
                >
                  <TextInput
                    style={styles.input} value={host} onChangeText={setHost}
                    placeholder="host or URL" placeholderTextColor="#555"
                    autoCapitalize="none" keyboardType="url"
                  />
                </Field>

                <Field label="Port (optional)" hint={selectedType === "ftp" ? "Default: 21" : "Default: 443"}>
                  <TextInput
                    style={styles.input} value={port} onChangeText={setPort}
                    placeholder="Leave blank for default" placeholderTextColor="#555"
                    keyboardType="number-pad"
                  />
                </Field>

                <Field label="Username">
                  <TextInput
                    style={styles.input} value={username} onChangeText={setUsername}
                    placeholder="username" placeholderTextColor="#555" autoCapitalize="none"
                  />
                </Field>

                <Field label="Password" hint="Stored encrypted on the server">
                  <View style={styles.inputRow}>
                    <TextInput
                      style={[styles.input, { flex: 1, borderWidth: 0 }]}
                      value={password} onChangeText={setPassword}
                      placeholder="password" placeholderTextColor="#555"
                      secureTextEntry={!showPassword}
                      autoComplete="off"
                      textContentType="password"
                    />
                    <TouchableOpacity
                      onPress={() => setShowPassword(v => !v)}
                      style={styles.eyeBtn}
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                    >
                      <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
                    </TouchableOpacity>
                  </View>
                </Field>

                <TouchableOpacity
                  style={[styles.saveBtn, createMutation.isPending && { opacity: 0.6 }]}
                  onPress={handleSaveFtpWebdav}
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending
                    ? <ActivityIndicator color="white" />
                    : <>
                        <Ionicons name="cloud-upload-outline" size={18} color="white" />
                        <Text style={styles.saveText}>Save Connection</Text>
                      </>
                  }
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint && <Text style={styles.fieldHint}>{hint}</Text>}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 12, color: "#666", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12,
  },
  typeCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: CARD, borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
  },
  typeCardSelected: { borderColor: PRIMARY, backgroundColor: "rgba(177,152,112,0.08)" },
  typeIcon: { width: 44, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  typeInfo: { flex: 1 },
  typeLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  typeDesc: { fontSize: 11, color: "#888", fontFamily: "Inter_400Regular", lineHeight: 16 },
  warnCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: "rgba(245,158,11,0.08)", borderRadius: 10, padding: 12, marginBottom: 14,
    borderWidth: 1, borderColor: "rgba(245,158,11,0.25)",
  },
  warnText: { flex: 1, fontSize: 12, color: "#d4a800", fontFamily: "Inter_400Regular", lineHeight: 17 },
  oauthBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    borderRadius: 14, paddingVertical: 15, marginTop: 4,
  },
  oauthBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  oauthHint: {
    fontSize: 11, color: "#555", fontFamily: "Inter_400Regular",
    textAlign: "center", marginTop: 10, lineHeight: 16,
  },
  fieldLabel: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 4 },
  fieldHint: { fontSize: 11, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 8 },
  input: {
    backgroundColor: "#222", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: "white", fontSize: 14, fontFamily: "Inter_400Regular",
    borderWidth: 1, borderColor: "rgba(177,152,112,0.18)",
  },
  inputRow: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#222", borderRadius: 10,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.18)", paddingHorizontal: 14,
  },
  eyeBtn: { paddingLeft: 8 },
  saveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 15, marginTop: 8,
  },
  saveText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
});
