import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Linking,
  AppState,
} from 'react-native';
import MapView, { Polyline, Marker } from 'react-native-maps';
import useLocation from '../hooks/useLocation';
import { calculateTotalDistance, formatDistance, formatDuration } from '../utils/distance';
import {
  filterValidSamples,
  buildWalkRecord,
  calculateElapsedSeconds,
  calculateSpeedKmh,
  SIGNAL_TIMEOUT_MS,
} from '../utils/track';
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
  // 약한 신호 안내는 산책(startedAt)당 한 번만 띄운다.
  const weakSignalShownForRef = useRef(null);

  // 화면 시간 = now - startedAt. now는 표시용으로 1초마다 갱신하고, 잠금·백그라운드에서 돌아오면 즉시 갱신한다.
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const {
    currentLocation,
    validCoords,
    acquiring,
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

  // 시간의 진실의 원천은 startedAt(실 시각)이다. 아래 효과는 화면 갱신만 맡는다.
  useEffect(() => {
    if (!isTracking) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
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
  // 정리 성공을 확인한 뒤에만 완료 상태로 바꾼다. 실패하면 busy를 유지한 채 다시 시도를 안내한다.
  // ("나중에"를 고르면 busy만 풀고 기록은 남긴다 → 다음 시작 때 pending-walk 경로로 다시 안내됨)
  const finishWalk = async (walkId) => {
    try {
      await clearActiveWalk(walkId);
    } catch (e) {
      Alert.alert(
        '정리하지 못했습니다',
        e?.message ?? '임시 기록을 정리하지 못했습니다.',
        [
          { text: '나중에', style: 'cancel', onPress: () => setBusyFlag(false) },
          { text: '다시 시도', onPress: () => finishWalk(walkId) },
        ],
        { cancelable: false }
      );
      return;
    }
    resetTracking();
    setBusyFlag(false);
  };

  // 저장 → 임시 기록 정리. 저장이 실패하면 임시 기록을 보존하고 다시 안내한다.
  const saveAndFinish = async (walk, endedAt, title) => {
    try {
      // 같은 id가 이미 이력에 있으면(저장 직후 종료된 경우) 다시 저장하지 않는다.
      if (!(await hasWalk(walk.id))) {
        // 좌표는 필터 없는 원본으로 저장하고, 거리·시간은 유효 샘플·실제 시작/종료 시각으로 계산한다.
        await saveWalk(
          buildWalkRecord({ id: walk.id, coords: walk.coords, startedAt: walk.startedAt, endedAt })
        );
      }
    } catch (e) {
      Alert.alert(
        '저장하지 못했습니다',
        e?.message ?? '산책 기록을 저장하지 못했습니다.',
        [
          { text: '다시 시도', onPress: () => saveAndFinish(walk, endedAt, title) },
          { text: '버리기', style: 'destructive', onPress: () => finishWalk(walk.id) },
        ],
        { cancelable: false }
      );
      return;
    }
    await finishWalk(walk.id);
  };

  // walk: { id, startedAt, coords(원본) }, endedAt: 종료 시각(ms)
  const promptSave = async (walk, endedAt, title = '산책 종료') => {
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
    if (filterValidSamples(walk.coords).length < 2) {
      Alert.alert(title, '경로가 너무 짧아 저장하지 않습니다.', [
        { text: '확인', onPress: () => finishWalk(walk.id) },
      ], { cancelable: false });
      return;
    }

    Alert.alert(
      title,
      '이번 산책을 저장할까요?',
      [
        { text: '저장', onPress: () => saveAndFinish(walk, endedAt, title) },
        { text: '버리기', style: 'destructive', onPress: () => finishWalk(walk.id) },
      ],
      { cancelable: false }
    );
  };

  // 중단된 산책의 종료 시각은 마지막으로 수집된 샘플 시각(없으면 시작 시각)
  const interruptedEndedAt = (walk) => {
    const last = walk.coords[walk.coords.length - 1];
    return last ? Math.max(walk.startedAt, last.timestamp) : walk.startedAt;
  };

  const promptInterrupted = (walk) =>
    promptSave(walk, interruptedEndedAt(walk), '이전 산책이 중단되었습니다');

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

  // discard=true: 저장 여부를 묻지 않고 기록을 버린다("신호가 약합니다" → 취소).
  const handleStop = async (discard = false) => {
    if (busyRef.current) return;
    setBusyFlag(true);
    const endedAt = Date.now(); // 사용자가 종료를 누른 시각 (중단 처리 지연과 무관)

    let result;
    try {
      result = await stopTracking();
    } catch (e) {
      result = { ok: false, reason: 'stop-failed', message: e?.message ?? String(e) };
    }
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
              handleStop(discard);
            },
          },
        ],
        { cancelable: false }
      );
      return;
    }

    const walk = result.walk ?? { id: String(endedAt), startedAt: endedAt, coords: [] };
    if (discard) {
      finishWalk(walk.id);
      return;
    }
    promptSave(walk, endedAt);
  };

  // 시작 후 30초 안에 유효 샘플(accuracy ≤ 20m)이 없으면 안내한다. 그대로 시작하면 계속 기다리고
  // (출발점·거리는 첫 유효 샘플부터), 취소하면 기록을 버린다.
  useEffect(() => {
    if (!acquiring || !startedAt || weakSignalShownForRef.current === startedAt) return undefined;
    const showAlert = () => {
      weakSignalShownForRef.current = startedAt;
      Alert.alert(
        '신호가 약합니다',
        'GPS 신호가 약해 정확한 출발점을 잡지 못했습니다. 그대로 시작할까요? (정확한 위치가 잡힌 지점부터 기록됩니다)',
        [
          { text: '취소', style: 'destructive', onPress: () => handleStop(true) },
          { text: '그대로 시작', style: 'default' },
        ],
        { cancelable: false }
      );
    };
    const remaining = SIGNAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      showAlert();
      return undefined;
    }
    const id = setTimeout(showAlert, remaining);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acquiring, startedAt]);

  const elapsed = isTracking && startedAt ? calculateElapsedSeconds(startedAt, now) : 0;
  const distance = calculateTotalDistance(validCoords);
  const speed = calculateSpeedKmh(distance, elapsed).toFixed(1);

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} initialRegion={INITIAL_REGION}>
        {validCoords.length > 0 && (
          <Marker coordinate={validCoords[0]} pinColor="blue" title="출발" />
        )}
        {validCoords.length > 1 && (
          <Polyline coordinates={validCoords} strokeColor="#22c55e" strokeWidth={4} />
        )}
      </MapView>

      {acquiring && (
        <View style={styles.acquiringBanner} pointerEvents="none">
          <Text style={styles.acquiringText}>GPS 신호 찾는 중…</Text>
        </View>
      )}

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
            onPress={() => handleStop()}
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
  acquiringBanner: {
    position: 'absolute',
    top: 16,
    alignSelf: 'center',
    backgroundColor: 'rgba(17,24,39,0.85)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  acquiringText: { color: '#fff', fontSize: 14, fontWeight: '600' },
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
