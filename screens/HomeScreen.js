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
import { saveWalk, hasWalk } from '../storage/walkStorage';

const INITIAL_REGION = {
  latitude: 37.5665,
  longitude: 126.978,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

export default function HomeScreen() {
  const mapRef = useRef(null);
  // 종료 처리(Alert 선택·'@active_walk' 정리 포함)가 끝날 때까지 재입력을 동기적으로 막는다.
  const busyRef = useRef(false);
  const notificationNoticeShownRef = useRef(false);

  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const {
    currentLocation,
    coords,
    isTracking,
    startedAt,
    restoring,
    interruptedWalk,
    startTracking,
    stopTracking,
    resetTracking,
    clearActiveWalk,
  } = useLocation();

  const setBusyFlag = (value) => {
    busyRef.current = value;
    setBusy(value);
  };

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

  // 저장/버리기가 끝난 뒤 임시 기록을 정리하고 종료 상태를 푼다.
  const finishWalk = async (walkId) => {
    try {
      await clearActiveWalk(walkId);
    } catch (e) {
      console.warn('[HomeScreen] clearActiveWalk failed', e?.message ?? e);
    }
    resetTracking();
    setElapsed(0);
    setBusyFlag(false);
  };

  // 저장 → 임시 기록 정리. 저장이 실패하면 임시 기록을 보존하고 다시 안내한다.
  const saveAndFinish = async (walk, duration, title) => {
    try {
      // 같은 id가 이미 이력에 있으면(저장 직후 종료된 경우) 다시 저장하지 않는다.
      if (!(await hasWalk(walk.id))) {
        await saveWalk({
          id: walk.id,
          date: new Date().toISOString(),
          coords: walk.coords,
          distance: calculateTotalDistance(walk.coords),
          duration,
        });
      }
    } catch (e) {
      Alert.alert(
        '저장하지 못했습니다',
        e?.message ?? '산책 기록을 저장하지 못했습니다.',
        [
          { text: '다시 시도', onPress: () => saveAndFinish(walk, duration, title) },
          { text: '버리기', style: 'destructive', onPress: () => finishWalk(walk.id) },
        ],
        { cancelable: false }
      );
      return;
    }
    await finishWalk(walk.id);
  };

  // walk: { id, startedAt, coords }
  const promptSave = async (walk, duration, title = '산책 종료') => {
    setBusyFlag(true);
    // 저장은 끝났는데 임시 기록만 남은 경우: 다시 묻지 않고 정리만 한다.
    try {
      if (await hasWalk(walk.id)) {
        await finishWalk(walk.id);
        return;
      }
    } catch (e) {
      console.warn('[HomeScreen] hasWalk failed', e?.message ?? e);
    }
    if (walk.coords.length < 2) {
      Alert.alert(title, '경로가 너무 짧아 저장하지 않습니다.', [
        { text: '확인', onPress: () => finishWalk(walk.id) },
      ], { cancelable: false });
      return;
    }

    Alert.alert(
      title,
      '이번 산책을 저장할까요?',
      [
        { text: '저장', onPress: () => saveAndFinish(walk, duration, title) },
        { text: '버리기', style: 'destructive', onPress: () => finishWalk(walk.id) },
      ],
      { cancelable: false }
    );
  };

  const approxDuration = (walk) => {
    const last = walk.coords[walk.coords.length - 1];
    return last ? Math.max(0, Math.round((last.timestamp - walk.startedAt) / 1000)) : 0;
  };

  const promptInterrupted = (walk) =>
    promptSave(walk, approxDuration(walk), '이전 산책이 중단되었습니다');

  // 서비스가 중단된 채 남은 이전 산책 → 저장/버리기 확인
  useEffect(() => {
    if (interruptedWalk) promptInterrupted(interruptedWalk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interruptedWalk]);

  const handleStart = async () => {
    if (busyRef.current) return;
    setLoading(true);
    const result = await startTracking();
    setLoading(false);

    if (result.ok) {
      if (result.notificationsBlocked && !notificationNoticeShownRef.current) {
        notificationNoticeShownRef.current = true;
        Alert.alert(
          '알림이 꺼져 있습니다',
          '알림이 꺼져 있어 기록 중 표시가 보이지 않습니다. 설정에서 알림을 켜 주세요.',
          [
            { text: '확인', style: 'cancel' },
            { text: '설정 열기', onPress: () => Linking.openSettings() },
          ]
        );
      }
      return;
    }

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
    } else if (result.reason === 'pending-walk') {
      promptInterrupted(result.walk);
    } else {
      Alert.alert('산책을 시작하지 못했습니다', result.message);
    }
  };

  const handleStop = async () => {
    if (busyRef.current) return;
    setBusyFlag(true);

    const result = await stopTracking();
    if (!result.ok) {
      // 수집이 계속 돌 수 있으므로 산책 중 상태와 임시 기록을 그대로 둔다.
      Alert.alert(
        '종료하지 못했습니다',
        result.message,
        [
          { text: '취소', style: 'cancel', onPress: () => setBusyFlag(false) },
          {
            text: '다시 시도',
            onPress: () => {
              setBusyFlag(false);
              handleStop();
            },
          },
        ],
        { cancelable: false }
      );
      return;
    }

    const walk = result.walk ?? { id: String(Date.now()), startedAt: Date.now(), coords: [] };
    promptSave(walk, elapsed);
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
        {loading || restoring ? (
          <ActivityIndicator size="large" color="#22c55e" />
        ) : isTracking ? (
          <TouchableOpacity
            style={[styles.btn, styles.stopBtn, busy && styles.btnDisabled]}
            onPress={handleStop}
            disabled={busy}
          >
            <Text style={styles.btnText}>산책 종료</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.btn, styles.startBtn, busy && styles.btnDisabled]}
            onPress={handleStart}
            disabled={busy}
          >
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
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
