import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import MapView, { Polyline, Marker } from 'react-native-maps';
import useLocation from '../hooks/useLocation';
import { calculateTotalDistance, formatDistance, formatDuration } from '../utils/distance';
import { saveWalk } from '../storage/walkStorage';

const INITIAL_REGION = {
  latitude: 37.5665,
  longitude: 126.978,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

export default function HomeScreen() {
  const mapRef = useRef(null);
  const timerRef = useRef(null);

  const [isWalking, setIsWalking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);

  const { currentLocation, coords, permissionError, startTracking, stopTracking, resetTracking } =
    useLocation();

  useEffect(() => {
    if (permissionError) {
      Alert.alert('권한 오류', '위치 권한이 필요합니다. 설정에서 허용해주세요.');
    }
  }, [permissionError]);

  useEffect(() => {
    if (currentLocation && mapRef.current) {
      mapRef.current.animateToRegion(
        {
          ...currentLocation,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        },
        500
      );
    }
  }, [currentLocation]);

  const handleStart = async () => {
    setLoading(true);
    const ok = await startTracking();
    setLoading(false);
    if (!ok) return;

    setIsWalking(true);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  };

  const handleStop = async () => {
    clearInterval(timerRef.current);
    stopTracking();
    setIsWalking(false);

    if (coords.length < 2) {
      Alert.alert('산책 종료', '경로가 너무 짧아 저장하지 않습니다.');
      resetTracking();
      setElapsed(0);
      return;
    }

    Alert.alert('산책 종료', '이번 산책을 저장할까요?', [
      {
        text: '저장',
        onPress: async () => {
          const distance = calculateTotalDistance(coords);
          await saveWalk({
            id: String(Date.now()),
            date: new Date().toISOString(),
            coords,
            distance,
            duration: elapsed,
          });
          resetTracking();
          setElapsed(0);
        },
      },
      {
        text: '버리기',
        style: 'destructive',
        onPress: () => {
          resetTracking();
          setElapsed(0);
        },
      },
    ]);
  };

  const distance = calculateTotalDistance(coords);
  const speed =
    elapsed > 0 ? ((distance / 1000) / (elapsed / 3600)).toFixed(1) : '0.0';

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} initialRegion={INITIAL_REGION}>
        {coords.length > 0 && (
          <Marker coordinate={coords[0]} pinColor="blue" title="출발" />
        )}
        {coords.length > 1 && (
          <Polyline coordinates={coords} strokeColor="#22c55e" strokeWidth={4} />
        )}
      </MapView>

      <View style={styles.statsBar}>
        <StatItem label="거리" value={formatDistance(distance)} />
        <StatItem label="시간" value={formatDuration(elapsed)} />
        <StatItem label="속도" value={`${speed}km/h`} />
      </View>

      <View style={styles.buttonArea}>
        {loading ? (
          <ActivityIndicator size="large" color="#22c55e" />
        ) : isWalking ? (
          <TouchableOpacity style={[styles.btn, styles.stopBtn]} onPress={handleStop}>
            <Text style={styles.btnText}>산책 종료</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.startBtn]} onPress={handleStart}>
            <Text style={styles.btnText}>산책 시작</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function StatItem({ label, value }) {
  return (
    <View style={styles.statItem}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderColor: '#e5e7eb',
  },
  statItem: { alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '700', color: '#111827' },
  statLabel: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  buttonArea: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: '#fff',
  },
  btn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  startBtn: { backgroundColor: '#22c55e' },
  stopBtn: { backgroundColor: '#ef4444' },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
