import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Platform, Alert, ActivityIndicator, Switch,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import {
  useCreateCloudConnection, useUpdateCloudConnection, useListCloudConnections,
  useTestCloudConnection, getListCloudConnectionsQueryKey, getUserFacingMessage, initiateOAuth,
  type CloudConnectionInput, type CloudConnectionUpdate, type OAuthNotConfigured,
} from "@workspace/api-client-react";
import { palette } from "@/components/ui/palette";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { API_BASE_URL } from "@/lib/config";
import { completeOAuthConnection, forgetOAuthNonce, rememberOAuthNonce } from "@/lib/oauthPending";

WebBrowser.maybeCompleteAuthSession();

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const BASE_URL = API_BASE_URL;

// `type` is the card's identity in this screen. `backendType` (when set) is what
// the server actually stores — e.g. Synology reuses the WebDAV upload path.
type CloudType = {
  type: string;
  backendType?: string;
  provider?: string;
  label: string;
  icon: string;
  color: string;
  set: "mci" | "ion";
  oAuth: boolean;
  desc: string;
  hostLabel?: string;
  hostHint?: string;
  portHint?: string;
  defaultPort?: string;
  usernameHint?: string;
  /** Username is part of the server path (Nextcloud), so it can't be left blank. */
  requiresUsername?: boolean;
  passwordLabel?: string;
  passwordHint?: string;
  note?: string;
};

const CLOUD_TYPES: CloudType[] = [
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
    type: "synology", backendType: "webdav", provider: "synology", label: "Synology NAS", icon: "nas", color: "#b19870", set: "mci", oAuth: false,
    desc: "Upload to a Synology DiskStation over WebDAV.",
    hostHint: "e.g. https://<your-nas-address> — your DDNS name or public address (not QuickConnect)",
    portHint: "Default: 5006 (WebDAV over HTTPS)", defaultPort: "5006",
    note:
      "Enable the “WebDAV Server” package in DSM (Package Center) and turn on HTTPS on port 5006. " +
      "Then use your DSM username and password below.\n\n" +
      "The NAS must be reachable from the internet on port 5006 (e.g. a Synology DDNS name with that port forwarded). " +
      "QuickConnect addresses won’t work — QuickConnect doesn’t relay WebDAV.\n\n" +
      "Note: Synology BeeStation appliances are not supported directly — they don’t offer WebDAV, FTP, or an upload API. " +
      "For a BeeStation, connect Google Drive / Dropbox / OneDrive instead and set the BeeStation to pull from that folder.",
  },
  {
    type: "nextcloud", label: "Nextcloud", icon: "cloud-outline", color: "#0082C9", set: "ion", oAuth: false,
    desc: "Upload straight to your own Nextcloud server.",
    hostLabel: "Server URL",
    hostHint: "e.g. https://cloud.example.com — the address you sign in at",
    portHint: "Default: 443 — leave blank unless your server uses a custom port", defaultPort: "",
    usernameHint: "Your Nextcloud login — it forms part of your files' address",
    requiresUsername: true,
    passwordLabel: "App Password",
    passwordHint: "Stored encrypted on the server",
    note:
      "Use an app password, not your account password: in Nextcloud go to Settings → Security → " +
      "“Create new app password”, name it KKamera, and paste the generated password below. " +
      "This is the only way that works when two-factor authentication is enabled, and you can revoke " +
      "it from that same screen without changing your account password.\n\n" +
      "Just enter your server address — the upload folder is created inside your Files automatically.",
  },
  {
    type: "webdav", label: "WebDAV Server", icon: "server-outline", color: "#6B7280", set: "ion", oAuth: false,
    desc: "Connect to any other WebDAV server (ownCloud, Seafile, etc.).",
    hostHint: "e.g. https://cloud.example.com/dav",
    portHint: "Default: 443", defaultPort: "",
  },
  {
    type: "ftp", label: "FTP / FTPS", icon: "folder-outline", color: "#8B5CF6", set: "ion", oAuth: false,
    desc: "Connect to an FTP server over FTPS (FTP over TLS). SFTP is not supported.",
    hostHint: "e.g. ftp.example.com",
    portHint: "Default: 21", defaultPort: "",
  },
];

type FieldErrors = Partial<Record<"type" | "name" | "host" | "port" | "username" | "password" | "form", string>>;

/** WebDAV-backed types (incl. Synology) and Nextcloud: the server rejects plain http:// URLs. */
function isHttpDavType(t: CloudType): boolean {
  const backend = t.backendType ?? t.type;
  return backend === "webdav" || backend === "nextcloud";
}

const HTTP_REJECTED =
  "Plain http:// isn't supported — it would send your password unencrypted. Use the https:// address instead.";

/** Server save errors, with a next step for the per-account connection cap. */
function saveErrorMessage(e: unknown, fallback: string): string {
  const msg = getUserFacingMessage(e, fallback);
  if (/(limit|maximum|at most|too many)/i.test(msg) && /connection/i.test(msg)) {
    return `${msg}\n\nRemove a connection you no longer use in Cloud Storage, then try again.`;
  }
  return msg;
}

export default function AddCloudScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { token } = useAuth();
  const { retryQueued } = useUpload();
  const createMutation = useCreateCloudConnection();
  const updateMutation = useUpdateCloudConnection();
  const testMutation = useTestCloudConnection();

  // `?edit=<id>` opens this screen as the edit form for an existing connection.
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  const routeEditId = edit && /^\d+$/.test(edit) ? Number(edit) : null;
  // Set after a new server connection is created, so a failed test leaves the
  // form editing that connection instead of creating another one.
  const [createdId, setCreatedId] = useState<number | null>(null);
  const editId = routeEditId ?? createdId;
  const { data: connections } = useListCloudConnections({
    query: { enabled: editId != null, queryKey: getListCloudConnectionsQueryKey() },
  });
  const editing = editId != null ? connections?.find(c => c.id === editId) : undefined;
  const prefilled = useRef(false);

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
  // Edit mode: a blank password field keeps the saved one; this clears it.
  const [clearPassword, setClearPassword] = useState(false);
  const [trustSelfSigned, setTrustSelfSigned] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!editing || prefilled.current) return;
    prefilled.current = true;
    const cardType = CLOUD_TYPES.find(t => t.provider && t.provider === editing.provider)?.type ?? editing.type;
    setSelectedType(cardType);
    setName(editing.name);
    setHost(editing.host ?? "");
    setPort(editing.port != null ? String(editing.port) : "");
    setUsername(editing.username ?? "");
    setPassword("");
    setClearPassword(false);
    setTrustSelfSigned(Boolean(editing.trustSelfSigned));
    setUploadPath(editing.uploadPath ?? "/KKamera");
  }, [editing]);

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
    const provider = selectedType;
    setOauthLoading(true);
    try {
      const platform = Platform.OS === "web" ? "web" : "native";
      // Through the shared client: base URL, bearer token, 401 → sign-out, a
      // request timeout, and no JSON.parse of an HTML proxy error page.
      let data: Awaited<ReturnType<typeof initiateOAuth>>;
      try {
        data = await initiateOAuth(provider as Parameters<typeof initiateOAuth>[0], {
          name: name.trim() || selected?.label,
          platform,
          uploadPath: uploadPath || "/KKamera",
        });
      } catch (e) {
        // ApiError carries the server's JSON body; a 503 here is OAuthNotConfigured.
        const errData = (e as { data?: Partial<OAuthNotConfigured> | null } | null)?.data;
        const msg = getUserFacingMessage(e, "Failed to start OAuth");
        if (errData && typeof errData === "object" && errData.missingEnv) {
          Alert.alert(
            "OAuth Not Configured",
            `${msg}\n\nAsk the app developer to add the required keys to the server environment.`,
          );
        } else {
          Alert.alert("Error", msg);
        }
        return;
      }

      const { authorizeUrl, nonce } = data as { authorizeUrl?: string; nonce?: string };
      if (!authorizeUrl || !nonce) {
        Alert.alert("Error", "The server did not return a sign-in link. Please try again.");
        return;
      }
      // The nonce never goes into a URL: it stays on this device until the
      // browser comes back, then proves to /oauth/complete that this device
      // started the flow (see lib/oauthPending.ts).
      await rememberOAuthNonce(provider, nonce);

      if (Platform.OS === "web") {
        // Web: navigate same window — OAuth returns to /oauth-success, which
        // completes the connection with the nonce from sessionStorage.
        window.location.href = authorizeUrl;
      } else {
        // Native: open in-app browser, intercept kkamera:// deep link
        const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, "kkamera://");
        if (result.type === "success" && result.url) {
          // The server deep-links back to kkamera://oauth-success (with the
          // pending connectionId + one-time code) on success, or
          // kkamera://oauth-error (with an error) on failure — both close the
          // auth browser, so inspect which one we got. searchParams.get()
          // already percent-decodes; decoding again threw URIError on a
          // literal "%" in the message.
          const url = new URL(result.url);
          const code = url.searchParams.get("code");
          const connectionIdParam = url.searchParams.get("connectionId");
          const errParam = url.searchParams.get("error");
          const isSuccess = /^kkamera:\/\/\/?oauth-success\b/.test(result.url);
          if (isSuccess && code) {
            // The account is only added once the server confirms it with this
            // device's nonce; until then nothing is listed or uploaded to.
            const completion = await completeOAuthConnection({
              provider,
              code,
              connectionId: connectionIdParam && /^\d+$/.test(connectionIdParam) ? Number(connectionIdParam) : null,
            });
            queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
            if (completion.ok) {
              // Captures parked waiting for a cloud can upload now.
              retryQueued(token);
              Alert.alert(
                "Connected!",
                `"${completion.name}" added successfully.`,
                [{ text: "Done", onPress: () => router.back() }]
              );
            } else {
              Alert.alert("Connection Failed", completion.message);
            }
          } else if (errParam) {
            void forgetOAuthNonce(provider);
            Alert.alert("Connection Failed", errParam.slice(0, 300));
          } else {
            void forgetOAuthNonce(provider);
            Alert.alert("Connection Failed", "The connection did not complete. Please try again.");
          }
        } else if (result.type === "cancel" || result.type === "dismiss") {
          // User cancelled — nothing was added.
          void forgetOAuthNonce(provider);
        } else {
          void forgetOAuthNonce(provider);
          Alert.alert("Auth Error", "OAuth flow did not complete. Please try again.");
        }
      }
    } catch (err) {
      Alert.alert("Error", getUserFacingMessage(err, "OAuth failed"));
    } finally {
      setOauthLoading(false);
    }
  };

  /** Client-side checks, shown inline under each field. Returns null when valid. */
  const validate = (): FieldErrors | null => {
    const next: FieldErrors = {};
    if (!selectedType || !selected) next.type = "Choose a storage type.";
    if (!name.trim()) next.name = "Give this connection a name.";
    if (selected && !selected.oAuth) {
      const h = host.trim();
      if (!h) next.host = `Enter the ${selected.hostLabel?.toLowerCase() ?? "server host or URL"}.`;
      else if (isHttpDavType(selected) && /^http:\/\//i.test(h)) next.host = HTTP_REJECTED;
      if (selected.requiresUsername && !username.trim()) next.username = `Enter your ${selected.label} username.`;
      const portNum = port.trim() ? Number(port.trim()) : null;
      if (portNum !== null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
        next.port = "Port must be a number between 1 and 65535.";
      }
      if (editing && editing.hasPassword && !clearPassword && !password) {
        const retargeted = h !== (editing.host ?? "") || portNum !== (editing.port ?? null);
        // The server won't send a saved password to a different host/port
        // unless it's re-entered in the same save (see retargetNeedsPassword).
        if (retargeted) next.password = "You changed the server host or port — re-enter the password for the new server (or clear the saved one).";
      }
    }
    return Object.keys(next).length ? next : null;
  };

  const runTest = async (id: number, savedName: string) => {
    setTesting(true);
    try {
      const result = await testMutation.mutateAsync({ id });
      setTestResult({ ok: result.success, message: result.message });
      if (result.success) {
        Alert.alert("Connected", `"${savedName}" is saved and working.`, [{ text: "Done", onPress: () => router.back() }]);
      }
    } catch (e) {
      // e.g. the per-user test rate limit (429) — show the server's message.
      setTestResult({ ok: false, message: getUserFacingMessage(e, "Could not test the connection.") });
    } finally {
      setTesting(false);
    }
  };

  /** Create (or update) a server connection, then test it before leaving. */
  const handleSaveAndTest = async () => {
    if (busy) return;
    const invalid = validate();
    if (invalid) { setErrors(invalid); return; }
    if (!selected || !selectedType) return;
    setErrors({});
    setTestResult(null);
    const trimmedName = name.trim();
    let id: number;
    try {
      if (editing) {
        const portNum = port.trim() ? parseInt(port, 10) : null;
        // Explicit null clears a saved port / username (the server treats a
        // missing field as "unchanged" and null as "clear").
        const data: CloudConnectionUpdate = {
          name: trimmedName,
          // Blank folder → null → the server resets it to the default folder.
          uploadPath: uploadPath.trim() || null,
          host: host.trim(),
          port: portNum,
          username: username.trim() || null,
          trustSelfSigned,
        };
        // Blank password = keep the saved one (field omitted); "Clear saved
        // password" sends null; anything typed replaces it.
        if (clearPassword) data.password = null;
        else if (password) data.password = password;
        await updateMutation.mutateAsync({ id: editing.id, data });
        id = editing.id;
      } else {
        const data: CloudConnectionInput = {
          type: (selected.backendType ?? selectedType) as CloudConnectionInput["type"],
          provider: selected.provider ?? null,
          name: trimmedName,
          host: host.trim() || null,
          port: port.trim() ? parseInt(port, 10) : null,
          username: username.trim() || null,
          password: password || null,
          uploadPath: uploadPath || "/KKamera",
          trustSelfSigned,
        };
        const created = await createMutation.mutateAsync({ data });
        id = created.id;
        // From here on this screen edits the connection it just created, so a
        // failed test can be fixed and re-tested without making a duplicate.
        prefilled.current = true;
        setCreatedId(created.id);
        // Captures parked waiting for a cloud can upload now.
        retryQueued(token);
      }
    } catch (e) {
      setErrors({ form: saveErrorMessage(e, editing ? "Failed to update connection." : "Failed to add connection.") });
      return;
    }
    queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
    await runTest(id, trimmedName);
  };

  /** OAuth connections: only the name and folder are editable here. */
  const handleSaveOAuthEdit = async () => {
    if (!editing || updateMutation.isPending) return;
    if (!name.trim()) { setErrors({ name: "Give this connection a name." }); return; }
    setErrors({});
    try {
      await updateMutation.mutateAsync({
        id: editing.id,
        data: { name: name.trim(), uploadPath: uploadPath.trim() || null },
      });
    } catch (e) {
      setErrors({ form: saveErrorMessage(e, "Failed to update connection.") });
      return;
    }
    queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
    Alert.alert("Connection Updated", `"${name.trim()}" saved.`, [{ text: "OK", onPress: () => router.back() }]);
  };

  const clearError = (key: keyof FieldErrors) => {
    if (errors[key] || errors.form) setErrors(prev => ({ ...prev, [key]: undefined, form: undefined }));
  };

  const isOAuthConfigured = selectedType ? oauthStatus[selectedType] !== false : true;
  const busy = testing || createMutation.isPending || updateMutation.isPending;
  const showHttpHint = !!selected && !selected.oAuth && isHttpDavType(selected)
    && /^http:\/\//i.test(host.trim()) && !errors.host;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>
      <KeyboardAwareScrollViewCompat contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionTitle}>{editId != null ? "Edit Connection" : "Choose Storage Type"}</Text>

        {editId != null && !editing && (
          <ActivityIndicator color={PRIMARY} style={{ marginVertical: 24 }} />
        )}

        {CLOUD_TYPES.filter(opt => editId == null || opt.type === selectedType).map(opt => (
          <TouchableOpacity
            key={opt.type}
            style={[styles.typeCard, selectedType === opt.type && styles.typeCardSelected]}
            disabled={editId != null}
            onPress={() => {
              setSelectedType(opt.type); setName(opt.label); setPort(opt.defaultPort ?? "");
              setErrors({}); setTestResult(null);
            }}
            accessibilityRole="radio"
            accessibilityLabel={`${opt.label}. ${opt.desc}`}
            accessibilityState={{ selected: selectedType === opt.type, disabled: editId != null }}
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

            {selected.note && (
              <View style={styles.infoCard}>
                <Ionicons name="information-circle-outline" size={18} color={PRIMARY} />
                <Text style={styles.infoText}>{selected.note}</Text>
              </View>
            )}

            <Field label="Connection Name" error={errors.name}>
              <TextInput
                style={[styles.input, errors.name && styles.inputError]} value={name}
                onChangeText={v => { setName(v); clearError("name"); }}
                placeholder={`e.g. My ${selected.label}`} placeholderTextColor="#777"
                accessibilityLabel="Connection name"
              />
            </Field>

            <Field label="Upload Folder" hint="Where photos and videos will be saved">
              <TextInput
                style={styles.input} value={uploadPath} onChangeText={setUploadPath}
                placeholder="/KKamera" placeholderTextColor="#777" autoCapitalize="none"
                accessibilityLabel="Upload folder"
              />
            </Field>

            {/* ── OAuth providers ── */}
            {selected.oAuth && (
              <>
                {!!errors.form && <FormError message={errors.form} />}
                {editing && (
                  <TouchableOpacity
                    style={[styles.saveBtn, { marginBottom: 16 }, updateMutation.isPending && { opacity: 0.6 }]}
                    onPress={handleSaveOAuthEdit}
                    disabled={updateMutation.isPending}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: updateMutation.isPending, busy: updateMutation.isPending }}
                  >
                    {updateMutation.isPending
                      ? <ActivityIndicator color="white" />
                      : <>
                          <Ionicons name="save-outline" size={18} color="white" />
                          <Text style={styles.saveText}>Save Changes</Text>
                        </>
                    }
                  </TouchableOpacity>
                )}

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
                  accessibilityRole="button"
                  accessibilityState={{ disabled: oauthLoading, busy: oauthLoading }}
                >
                  {oauthLoading
                    ? <ActivityIndicator color="white" />
                    : <>
                        {selected.set === "mci"
                          ? <MaterialCommunityIcons name={selected.icon as any} size={20} color="white" />
                          : <Ionicons name={selected.icon as any} size={20} color="white" />
                        }
                        <Text style={styles.oauthBtnText}>{editing ? "Reconnect" : "Connect with"} {selected.label}</Text>
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
                  label={selected.hostLabel ?? "Server Host / URL"}
                  hint={selected.hostHint ?? "host or URL"}
                  error={errors.host}
                >
                  <TextInput
                    style={[styles.input, errors.host && styles.inputError]} value={host}
                    onChangeText={v => { setHost(v); clearError("host"); }}
                    placeholder="host or URL" placeholderTextColor="#777"
                    autoCapitalize="none" autoCorrect={false} keyboardType="url"
                    accessibilityLabel={selected.hostLabel ?? "Server host or URL"}
                  />
                  {showHttpHint && (
                    <View style={styles.inlineWarn} accessibilityLiveRegion="polite">
                      <Ionicons name="warning-outline" size={14} color="#f59e0b" accessible={false} />
                      <Text style={styles.inlineWarnText}>{HTTP_REJECTED}</Text>
                    </View>
                  )}
                </Field>

                <Field label="Port (optional)" hint={selected.portHint ?? "Leave blank for default"} error={errors.port}>
                  <TextInput
                    style={[styles.input, errors.port && styles.inputError]} value={port}
                    onChangeText={v => { setPort(v); clearError("port"); }}
                    placeholder="Leave blank for default" placeholderTextColor="#777"
                    keyboardType="number-pad"
                    accessibilityLabel="Port, optional"
                  />
                </Field>

                <Field label="Username" hint={selected.usernameHint} error={errors.username}>
                  <TextInput
                    style={[styles.input, errors.username && styles.inputError]} value={username}
                    onChangeText={v => { setUsername(v); clearError("username"); }}
                    placeholder="username" placeholderTextColor="#777" autoCapitalize="none" autoCorrect={false}
                    accessibilityLabel="Username"
                  />
                </Field>

                <Field
                  label={selected.passwordLabel ?? "Password"}
                  hint={selected.passwordHint ?? "Stored encrypted on the server"}
                  error={errors.password}
                >
                  <View style={[styles.inputRow, errors.password && styles.inputError]}>
                    <TextInput
                      style={[styles.input, { flex: 1, borderWidth: 0 }]}
                      value={password}
                      onChangeText={(v) => { setPassword(v); if (v) setClearPassword(false); clearError("password"); }}
                      accessibilityLabel={selected.passwordLabel ?? "Password"}
                      editable={!clearPassword}
                      placeholder={
                        clearPassword ? "Saved password will be removed"
                          : editing?.hasPassword ? "Leave blank to keep (re-enter if you change the host)"
                          : "password"
                      }
                      placeholderTextColor="#777"
                      secureTextEntry={!showPassword}
                      autoComplete="off"
                      textContentType="password"
                    />
                    <TouchableOpacity
                      onPress={() => setShowPassword(v => !v)}
                      style={styles.eyeBtn}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                    >
                      <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
                    </TouchableOpacity>
                  </View>
                  {editing?.hasPassword && (
                    <TouchableOpacity
                      style={styles.clearPwBtn}
                      onPress={() => { setClearPassword(v => !v); setPassword(""); clearError("password"); }}
                      accessibilityRole="checkbox"
                      accessibilityLabel="Clear saved password"
                      accessibilityState={{ checked: clearPassword }}
                    >
                      <Ionicons name={clearPassword ? "checkbox" : "square-outline"} size={18} color={clearPassword ? "#ef4444" : "#888"} />
                      <Text style={styles.clearPwText}>Clear saved password</Text>
                    </TouchableOpacity>
                  )}
                </Field>

                <View style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel} nativeID="trustSelfSignedLabel">Trust self-signed certificate</Text>
                    <Text style={styles.fieldHint}>
                      Only turn this on for your own server that uses a certificate you created. It skips the
                      check that proves you're talking to the real server, so a network attacker could
                      intercept your password and files.
                    </Text>
                  </View>
                  <Switch
                    value={trustSelfSigned}
                    onValueChange={v => { setTrustSelfSigned(v); setTestResult(null); }}
                    trackColor={{ false: "#3a352c", true: "#f59e0b" }}
                    thumbColor="white"
                    accessibilityLabel="Trust self-signed certificate"
                    accessibilityHint="Less secure. Only for your own server."
                  />
                </View>

                {!!errors.form && <FormError message={errors.form} />}

                {testResult && (
                  <View
                    style={[styles.testCard, testResult.ok ? styles.testCardOk : styles.testCardFail]}
                    accessibilityLiveRegion="polite"
                  >
                    <Ionicons
                      name={testResult.ok ? "checkmark-circle-outline" : "close-circle-outline"}
                      size={18} color={testResult.ok ? palette.success : palette.dangerText} accessible={false}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.testTitle, { color: testResult.ok ? palette.success : palette.dangerText }]}>
                        {testResult.ok ? "Connection works" : "Connection test failed"}
                      </Text>
                      <Text style={styles.testMsg}>{testResult.message}</Text>
                      {!testResult.ok && createdId != null && (
                        <Text style={styles.testMsg}>
                          The connection was saved. Fix the details above and tap “Save & Test” again, or keep it as is.
                        </Text>
                      )}
                    </View>
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.saveBtn, busy && { opacity: 0.6 }]}
                  onPress={handleSaveAndTest}
                  disabled={busy || (editId != null && !editing)}
                  accessibilityRole="button"
                  accessibilityHint="Saves the connection, then checks KKamera can reach it"
                  accessibilityState={{ disabled: busy, busy }}
                >
                  {busy
                    ? <>
                        <ActivityIndicator color="white" />
                        <Text style={styles.saveText}>{testing ? "Testing connection…" : "Saving…"}</Text>
                      </>
                    : <>
                        <Ionicons name={editing ? "save-outline" : "cloud-upload-outline"} size={18} color="white" />
                        <Text style={styles.saveText}>{testResult && !testResult.ok ? "Save & Test Again" : "Save & Test"}</Text>
                      </>
                  }
                </TouchableOpacity>
                {testResult && !testResult.ok && (
                  <TouchableOpacity
                    style={styles.keepBtn}
                    onPress={() => router.back()}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Text style={styles.keepText}>Keep without a working test</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </>
        )}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint && <Text style={styles.fieldHint}>{hint}</Text>}
      {children}
      {!!error && (
        <Text style={styles.fieldError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>
      )}
    </View>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <View style={styles.formError} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Ionicons name="alert-circle-outline" size={18} color={palette.dangerText} accessible={false} />
      <Text style={styles.formErrorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 12, color: palette.textSubtle, fontFamily: "Inter_600SemiBold",
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
  typeDesc: { fontSize: 12, color: "#9a948b", fontFamily: "Inter_400Regular", lineHeight: 16 },
  warnCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: "rgba(245,158,11,0.08)", borderRadius: 10, padding: 12, marginBottom: 14,
    borderWidth: 1, borderColor: "rgba(245,158,11,0.25)",
  },
  warnText: { flex: 1, fontSize: 12, color: "#d4a800", fontFamily: "Inter_400Regular", lineHeight: 17 },
  infoCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: "rgba(177,152,112,0.08)", borderRadius: 10, padding: 12, marginBottom: 14,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.25)",
  },
  infoText: { flex: 1, fontSize: 12, color: "#c3b091", fontFamily: "Inter_400Regular", lineHeight: 17 },
  oauthBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    borderRadius: 14, paddingVertical: 15, marginTop: 4,
  },
  oauthBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  oauthHint: {
    fontSize: 12, color: palette.textSubtle, fontFamily: "Inter_400Regular",
    textAlign: "center", marginTop: 10, lineHeight: 16,
  },
  fieldLabel: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 4 },
  fieldHint: { fontSize: 12, color: palette.textSubtle, fontFamily: "Inter_400Regular", marginBottom: 8, lineHeight: 16 },
  fieldError: { fontSize: 12, color: palette.dangerText, fontFamily: "Inter_500Medium", marginTop: 6, lineHeight: 16 },
  inputError: { borderWidth: 1, borderColor: palette.dangerText },
  inlineWarn: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 6 },
  inlineWarnText: { flex: 1, fontSize: 12, color: "#fbbf24", fontFamily: "Inter_400Regular", lineHeight: 16 },
  switchRow: {
    flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14,
    backgroundColor: CARD, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
  },
  formError: {
    flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 12,
    backgroundColor: "rgba(239,68,68,0.08)", borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
  },
  formErrorText: { flex: 1, fontSize: 13, color: palette.dangerText, fontFamily: "Inter_400Regular", lineHeight: 18 },
  testCard: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 12, borderRadius: 10, padding: 12, borderWidth: 1 },
  testCardOk: { backgroundColor: "rgba(34,197,94,0.08)", borderColor: "rgba(34,197,94,0.3)" },
  testCardFail: { backgroundColor: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)" },
  testTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  testMsg: { fontSize: 12, color: palette.textMuted, fontFamily: "Inter_400Regular", lineHeight: 17, marginTop: 2 },
  keepBtn: { alignItems: "center", justifyContent: "center", minHeight: 44, marginTop: 8 },
  keepText: { fontSize: 14, color: palette.textMuted, fontFamily: "Inter_500Medium" },
  input: {
    backgroundColor: "#222", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: "white", fontSize: 14, fontFamily: "Inter_400Regular",
    borderWidth: 1, borderColor: "rgba(177,152,112,0.18)",
  },
  inputRow: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#222", borderRadius: 10,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.18)", paddingHorizontal: 14,
  },
  eyeBtn: { paddingLeft: 8, paddingVertical: 10 },
  clearPwBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, minHeight: 44 },
  clearPwText: { fontSize: 13, color: "#aaa", fontFamily: "Inter_400Regular" },
  saveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 15, marginTop: 8,
  },
  saveText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  backBtn: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, gap: 4 },
});
