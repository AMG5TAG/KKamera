import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Platform, Alert, ActivityIndicator, Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateCloudConnection, getListCloudConnectionsQueryKey } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const CLOUD_TYPES = [
  {
    type: "googledrive", label: "Google Drive", icon: "google-drive", color: "#4285F4", set: "mci", oAuth: true,
    desc: "Upload directly to your Google Drive using a personal access token.",
    tokenHelp: "Get a token from Google OAuth 2.0 Playground (oauth2.googleapis.com/tokeninfo) with scope: drive.file",
    tokenHelpUrl: "https://developers.google.com/oauthplayground",
  },
  {
    type: "onedrive", label: "OneDrive", icon: "microsoft-onedrive", color: "#0078D4", set: "mci", oAuth: true,
    desc: "Upload directly to your OneDrive using a Microsoft Graph access token.",
    tokenHelp: "Get a token from Microsoft Graph Explorer (developer.microsoft.com/graph/graph-explorer)",
    tokenHelpUrl: "https://developer.microsoft.com/en-us/graph/graph-explorer",
  },
  {
    type: "dropbox", label: "Dropbox", icon: "dropbox", color: "#0061FF", set: "mci", oAuth: true,
    desc: "Upload directly to your Dropbox using a personal access token.",
    tokenHelp: "Create an app at dropbox.com/developers/apps and generate a long-lived access token.",
    tokenHelpUrl: "https://www.dropbox.com/developers/apps",
  },
  {
    type: "webdav", label: "WebDAV Server", icon: "server-outline", color: "#6B7280", set: "ion", oAuth: false,
    desc: "Connect to any WebDAV-compatible server (Nextcloud, ownCloud, etc.).",
    tokenHelp: null, tokenHelpUrl: null,
  },
  {
    type: "ftp", label: "FTP / SFTP", icon: "folder-outline", color: "#8B5CF6", set: "ion", oAuth: false,
    desc: "Connect to an FTP server to upload photos and videos.",
    tokenHelp: null, tokenHelpUrl: null,
  },
];

export default function AddCloudScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const createMutation = useCreateCloudConnection();

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [uploadPath, setUploadPath] = useState("/KKamera");
  const [showPassword, setShowPassword] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const selected = CLOUD_TYPES.find(t => t.type === selectedType);

  const handleSave = async () => {
    if (!selectedType || !name.trim()) {
      Alert.alert("Missing Info", "Please choose a storage type and give it a name.");
      return;
    }
    if (selected?.oAuth && !accessToken.trim()) {
      Alert.alert("Access Token Required", "Please paste your access token to connect this service.");
      return;
    }
    if (!selected?.oAuth && !host.trim()) {
      Alert.alert("Missing Info", "Please enter the server host/URL.");
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
          // oauthCode field is repurposed to carry the access token
          oauthCode: accessToken || null,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
      Alert.alert(
        "Connection Added",
        `"${name}" has been saved. Go to Cloud Storage settings to test the connection.`,
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.message || "Failed to add connection.");
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
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

        {selectedType && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Connection Details</Text>

            <Field label="Connection Name">
              <TextInput style={styles.input} value={name} onChangeText={setName}
                placeholder="e.g. My Google Drive" placeholderTextColor="#555" />
            </Field>

            <Field label="Upload Folder" hint="Where photos and videos will be saved">
              <TextInput style={styles.input} value={uploadPath} onChangeText={setUploadPath}
                placeholder="/KKamera" placeholderTextColor="#555" autoCapitalize="none" />
            </Field>

            {selected?.oAuth && (
              <>
                <View style={styles.tokenHelpCard}>
                  <Ionicons name="key-outline" size={18} color={PRIMARY} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tokenHelpTitle}>How to get your access token</Text>
                    <Text style={styles.tokenHelpText}>{selected.tokenHelp}</Text>
                    {selected.tokenHelpUrl && (
                      <TouchableOpacity onPress={() => Linking.openURL(selected.tokenHelpUrl!)}>
                        <Text style={styles.tokenHelpLink}>Open {selected.label} Developer Portal ↗</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <Field label="Access Token" hint="Paste your OAuth access token here — stored encrypted">
                  <View style={styles.inputRow}>
                    <TextInput
                      style={[styles.input, { flex: 1, borderWidth: 0 }]}
                      value={accessToken}
                      onChangeText={setAccessToken}
                      placeholder="Paste access token..."
                      placeholderTextColor="#555"
                      secureTextEntry={!showToken}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity onPress={() => setShowToken(v => !v)} style={styles.eyeBtn}>
                      <Ionicons name={showToken ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
                    </TouchableOpacity>
                  </View>
                </Field>
              </>
            )}

            {!selected?.oAuth && (
              <>
                <Field label="Server Host / URL" hint={selectedType === "webdav" ? "e.g. https://cloud.example.com/dav" : "e.g. ftp.example.com"}>
                  <TextInput style={styles.input} value={host} onChangeText={setHost}
                    placeholder="host or URL" placeholderTextColor="#555"
                    autoCapitalize="none" keyboardType="url" />
                </Field>
                <Field label="Port (optional)" hint={selectedType === "ftp" ? "Default: 21" : "Default: 443"}>
                  <TextInput style={styles.input} value={port} onChangeText={setPort}
                    placeholder="Leave blank for default" placeholderTextColor="#555" keyboardType="number-pad" />
                </Field>
                <Field label="Username">
                  <TextInput style={styles.input} value={username} onChangeText={setUsername}
                    placeholder="username" placeholderTextColor="#555" autoCapitalize="none" />
                </Field>
                <Field label="Password" hint="Stored encrypted on server">
                  <View style={styles.inputRow}>
                    <TextInput style={[styles.input, { flex: 1, borderWidth: 0 }]} value={password} onChangeText={setPassword}
                      placeholder="password" placeholderTextColor="#555" secureTextEntry={!showPassword} />
                    <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={styles.eyeBtn}>
                      <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
                    </TouchableOpacity>
                  </View>
                </Field>
              </>
            )}

            <TouchableOpacity
              style={[styles.saveBtn, createMutation.isPending && styles.saveBtnDisabled]}
              onPress={handleSave}
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
  content: { padding: 16 },
  sectionTitle: { fontSize: 12, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 },
  typeCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: CARD, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  typeCardSelected: { borderColor: PRIMARY, backgroundColor: "rgba(177,152,112,0.08)" },
  typeIcon: { width: 44, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  typeInfo: { flex: 1 },
  typeLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  typeDesc: { fontSize: 11, color: "#888", fontFamily: "Inter_400Regular", lineHeight: 16 },
  tokenHelpCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: "rgba(177,152,112,0.08)", borderRadius: 10, padding: 12, marginBottom: 14,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.2)",
  },
  tokenHelpTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#d4c5b0", marginBottom: 4 },
  tokenHelpText: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular", lineHeight: 17, marginBottom: 6 },
  tokenHelpLink: { fontSize: 12, color: PRIMARY, fontFamily: "Inter_500Medium" },
  fieldLabel: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 4 },
  fieldHint: { fontSize: 11, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 8 },
  input: { backgroundColor: "#222", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: "white", fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.18)" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#222", borderRadius: 10, borderWidth: 1, borderColor: "rgba(177,152,112,0.18)", paddingHorizontal: 14 },
  eyeBtn: { paddingLeft: 8 },
  saveBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 15, marginTop: 8 },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
});
