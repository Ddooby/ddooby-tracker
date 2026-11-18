import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Linking,
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

  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);

  const {
    currentLocation,
    coords,
    isTracking,
    startedAt,
    interruptedWalk,
    startTracking,
    stopTracking,
    resetTracking,
    clearActiveWalk,
  } = useLocation();

  // 타이머 표시: 시작/복원 시점에 startedAt 기준 대략값으로 맞추고 이후 1초씩 증가.
  // 정확한 시간 계산(시작/종료 시각 기반)은 TRK-02 범위.
  useEffect(() => {
    if (!isTracking) return undefined;
    setElapsed(startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [isTracking, startedAt]);

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

  const finishWalk = async () => {
    await clearActiveWalk();
    resetTracking();
    setElapsed(0);
  };

  const promptSave = (finalCoords, duration, title = '산책 종료') => {
    if (finalCoords.length < 2) {
      Alert.alert(title, '경로가 너무 짧아 저장하지 않습니다.');
      finishWalk();
      return;
    }

    Alert.alert(title, '이번 산책을 저장할까요?', [
      {
        text: '저장',
        onPress: async () => {
          const distance = calculateTotalDistance(finalCoords);
          await saveWalk({
            id: String(Date.now()),
            date: new Date().toISOString(),
            coords: finalCoords,
            distance,
            duration,
          });
          await finishWalk();
        },
      },
      {
        text: '버리기',
        style: 'destructive',
        onPress: () => finishWalk(),
      },
    ]);
  };

  // 서비스가 중단된 채 남은 이전 산책 → 저장/버리기 확인
  useEffect(() => {
    if (!interruptedWalk) return;
    const last = interruptedWalk.coords[interruptedWalk.coords.length - 1];
    const approx = last
      ? Math.max(0, Math.round((last.timestamp - interruptedWalk.startedAt) / 1000))
      : 0;
    promptSave(interruptedWalk.coords, approx, '이전 산책이 중단되었습니다');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interruptedWalk]);

  const handleStart = async () => {
    setLoading(true);
    const result = await startTracking();
    setLoading(false);
    if (result.ok) return;

    if (result.reason === 'permission') {
      Alert.alert(
        '위치 권한이 필요합니다',
        result.canAskAgain
          ? '산책 경로를 기록하려면 위치 권한을 허용해주세요.'
          : '설정에서 위치 권한을 "앱 사용 중 허용"으로 바꿔주세요.',
        result.canAskAgain
          ? [
              { text: '취소', style: 'cancel' },
              { text: '다시 시도', onPress: handleStart },
            ]
          : [
              { text: '취소', style: 'cancel' },
              { text: '설정 열기', onPress: () => Linking.openSettings() },
            ]
      );
    } else {
      Alert.alert('산책을 시작하지 못했습니다', result.message);
    }
  };

  const handleStop = async () => {
    const finalCoords = await stopTracking();
    promptSave(finalCoords, elapsed);
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
        ) : isTracking ? (
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
