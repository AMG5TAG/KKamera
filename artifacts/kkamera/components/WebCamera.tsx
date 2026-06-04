import React, { useRef, useState, useCallback, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#b19870";
const BG = "#0d0b08";

interface WebCameraProps {
  onCapture: (uri: string, fileName: string, type: "image" | "video") => void;
  onClose: () => void;
}

export function WebCamera({ onCapture, onClose }: WebCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState("");
  const [facingUser, setFacingUser] = useState(true);

  const startStream = useCallback(async (user: boolean) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: user ? "user" : "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    } catch (e: any) {
      setError("Camera access denied. Allow camera access in your browser settings.");
    }
  }, []);

  useEffect(() => {
    startStream(facingUser);
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, [startStream, facingUser]);

  const capturePhoto = () => {
    if (!videoRef.current || !streamRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) return;
      const uri = URL.createObjectURL(blob);
      const fileName = `photo_${Date.now()}.jpg`;
      onCapture(uri, fileName, "image");
    }, "image/jpeg", 0.95);
  };

  const startVideo = () => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const mr = new MediaRecorder(streamRef.current, { mimeType });
    mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const uri = URL.createObjectURL(blob);
      const fileName = `video_${Date.now()}.webm`;
      onCapture(uri, fileName, "video");
    };
    mr.start(100);
    mediaRecorderRef.current = mr;
    setIsRecording(true);
  };

  const stopVideo = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  if (Platform.OS !== "web") return null;

  if (error) {
    return (
      <View style={styles.errorBox}>
        <Ionicons name="videocam-off-outline" size={40} color="#555" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Native video element via ref */}
      <video
        ref={videoRef as any}
        style={{ width: "100%", height: "100%", objectFit: "cover" } as any}
        muted
        playsInline
        autoPlay
      />

      {/* Controls overlay */}
      <View style={styles.overlay}>
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.iconBtn} onPress={onClose}>
            <Ionicons name="close" size={24} color="white" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setFacingUser(v => !v)}>
            <Ionicons name="camera-reverse-outline" size={24} color="white" />
          </TouchableOpacity>
        </View>

        <View style={styles.bottomBar}>
          {/* Photo */}
          <TouchableOpacity style={styles.photoBtn} onPress={capturePhoto} disabled={isRecording}>
            <Ionicons name="camera" size={28} color={isRecording ? "#555" : "white"} />
          </TouchableOpacity>

          {/* Record */}
          <TouchableOpacity
            style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
            onPress={isRecording ? stopVideo : startVideo}
          >
            {isRecording
              ? <View style={styles.stopIcon} />
              : <View style={styles.recordIcon} />}
          </TouchableOpacity>
        </View>

        {isRecording && (
          <View style={styles.recBadge}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>REC</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", position: "relative" } as any,
  overlay: {
    position: "absolute" as any, top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: "space-between",
  },
  topBar: { flexDirection: "row", justifyContent: "space-between", padding: 16, paddingTop: 48 },
  bottomBar: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 32, paddingBottom: 48 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" },
  photoBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.4)" },
  recordBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "white" },
  recordBtnActive: { borderColor: "#ef4444" },
  recordIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#ef4444" },
  stopIcon: { width: 22, height: 22, borderRadius: 4, backgroundColor: "#ef4444" },
  recBadge: { position: "absolute" as any, top: 52, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(239,68,68,0.8)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "white" },
  recText: { fontSize: 12, fontFamily: "Inter_700Bold", color: "white", letterSpacing: 1 },
  errorBox: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  errorText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  closeBtn: { backgroundColor: PRIMARY, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  closeBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
});
