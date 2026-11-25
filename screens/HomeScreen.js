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
import { formatDistance, formatDuration } from '../utils/distance';
import {
  hasValidPath,
  normalizePauses,
  sumSegmentsDistance,
  buildWalkRecord,
  calculateElapsedSeconds,
  calculateMovingSeconds,
  calculateSpeedKmh,
  resolveEndedAt,
  ALIVE_HEARTBEAT_MS,
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
  // 첫 종료 요청 시각. 종료 재시도(읽기 실패 등)에서도 새로 잡지 않고 보존하며, 저장/버리기로 끝나거나
  // 종료를 취소하면 비운다. 서비스 중단이 확정되면 hook이 이 값을 '@active_walk'에 영속화한다.
  const endRequestRef = useRef(null);

  // 화면 시간 = now - startedAt. now는 표시용으로 1초마다 갱신하고, 잠금·백그라운드에서 돌아오면 즉시 갱신한다.
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const {
    currentLocation,
    heading,
    segments,
    validCoords,
    acquiring,
    isTracking,
    isPaused,
    pausedAt,
    pauses,
    startedAt,
    restoring,
    heartbeat,
    lostPending,
    interruptedWalk,
    startTracking,
    pauseTracking,
    resumeTracking,
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

  // 산책 중 앱이 화면에 있는 동안 ALIVE_HEARTBEAT_MS(목표 5초, 보장 아님)마다 그리고 화면 복귀 즉시, 서비스·권한을
  // 확인한 뒤에만 메타에 lastAliveAt을 기록한다(hook.heartbeat). 서비스 중단·권한 없음·확인 오류면 기록하지 않고
  // 수집 중 표시를 내려 "중단된 산책" 저장/버리기 경로로 전환한다. 강제 종료로 종료 시각을 영속화하지 못해도
  // 복원이 마지막 샘플·마지막 정상 하트비트까지를 하한으로 쓴다(endedAtEstimated). 백그라운드에서는 쓰지 않는다.
  useEffect(() => {
    // lost 전환의 읽기가 실패해 재시도 중(lostPending)이면 isTracking이 꺼져 있어도 하트비트를 계속 돈다.
    if (!isTracking && !lostPending) return undefined;
    // 일시정지 중에는 서비스가 꺼져 있는 것이 정상이므로 하트비트를 돌리지 않는다(lost로 오판 방지).
    if (isPaused && !lostPending) return undefined;
    let timer = null;
    const beat = () => {
      heartbeat().then(
        (status) => {
          if (status === 'lost') stop();
        },
        () => {}
      );
    };
    const start = () => {
      if (timer) return;
      beat();
      timer = setInterval(beat, ALIVE_HEARTBEAT_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [isTracking, isPaused, lostPending, heartbeat]);

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
    endRequestRef.current = null;
    resetTracking();
    setBusyFlag(false);
  };

  // 저장 → 임시 기록 정리. 저장이 실패하면 임시 기록을 보존하고 다시 안내한다.
  const saveAndFinish = async (walk, endedAt, title, estimated = false) => {
    try {
      // 같은 id가 이미 이력에 있으면(저장 직후 종료된 경우) 다시 저장하지 않는다.
      if (!(await hasWalk(walk.id))) {
        // 좌표는 필터 없는 원본으로 저장하고, 거리·시간은 유효 샘플·실제 시작/종료 시각으로 계산한다.
        await saveWalk(
          buildWalkRecord({
            id: walk.id,
            coords: walk.coords,
            startedAt: walk.startedAt,
            endedAt,
            endedAtEstimated: estimated,
            pauses: walk.pauses,
            pausedAt: walk.pausedAt, // 일시정지 상태로 종료했으면 종료 시각까지 일시정지로 본다
          })
        );
      }
    } catch (e) {
      Alert.alert(
        '저장하지 못했습니다',
        e?.message ?? '산책 기록을 저장하지 못했습니다.',
        [
          { text: '다시 시도', onPress: () => saveAndFinish(walk, endedAt, title, estimated) },
          { text: '버리기', style: 'destructive', onPress: () => finishWalk(walk.id) },
        ],
        { cancelable: false }
      );
      return;
    }
    await finishWalk(walk.id);
  };

  // walk: { id, startedAt, coords(원본), pauses?, pausedAt? }, endedAt: 종료 시각(ms), estimated: 마지막 샘플 시각으로 추정한 값인지
  const promptSave = async (walk, endedAt, title = '산책 종료', estimated = false) => {
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
    // 유효 경로가 2점 미만이거나 위치가 하나도 없어도 자동으로 지우지 않고 선택하게 한다
    // (원본·시간은 그대로 저장, 거리 0, quality 표시).
    const noLocation = walk.coords.length === 0;
    const noValidPath =
      noLocation || !hasValidPath(walk.coords, normalizePauses(walk.pauses, walk.pausedAt, endedAt));
    Alert.alert(
      title,
      noLocation
        ? '위치가 기록되지 않았습니다. 저장하면 시간만 저장되고 거리는 0m입니다. 저장할까요?'
        : noValidPath
          ? 'GPS 신호가 약해 경로를 측정하지 못했습니다. 저장하면 기록된 위치와 시간만 저장되고 거리는 0m입니다. 저장할까요?'
          : '이번 산책을 저장할까요?',
      [
        { text: '저장', onPress: () => saveAndFinish(walk, endedAt, title, estimated) },
        { text: '버리기', style: 'destructive', onPress: () => finishWalk(walk.id) },
      ],
      { cancelable: false }
    );
  };

  // 종료 시각이 영속화돼 있으면 그 값을 쓴다. OS가 수집을 중단해 종료 시각이 없는 경우에만 마지막으로
  // 수집된 샘플 시각을 하한으로 추정하고 기록에 endedAtEstimated를 표시한다(resolveEndedAt).
  const promptInterrupted = (walk) => {
    const { endedAt, estimated } = resolveEndedAt(walk);
    promptSave(walk, endedAt, '이전 산책이 중단되었습니다', estimated);
  };

  // 서비스가 중단된 채 남은 이전 산책 → 저장/버리기 확인
  useEffect(() => {
    if (interruptedWalk) promptInterrupted(interruptedWalk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interruptedWalk]);

  const handleStart = async () => {
    // 중단 전환(임시 기록 읽기)이 끝나기 전에는 새 산책을 시작하지 않는다.
    if (busyRef.current || lostPending) return;
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

  // 일시정지/다시 시작: 종료·시작과 같은 busy 가드를 쓰고, 실패하면 상태를 그대로 둔 채 안내한다.
  const handlePause = async () => {
    if (busyRef.current || lostPending || !isTracking || isPaused) return;
    setBusyFlag(true);
    let result;
    try {
      result = await pauseTracking(Date.now());
    } catch (e) {
      result = { ok: false, reason: 'pause-failed', message: e?.message ?? String(e) };
    }
    setBusyFlag(false);
    if (!result.ok) {
      if (result.reason !== 'invalid') {
        Alert.alert('일시정지하지 못했습니다', result.message ?? '위치 수집을 멈추지 못했습니다.');
      }
      return;
    }
    if (result.unconfirmed) {
      Alert.alert(
        '일시정지했습니다',
        '위치 수집이 멈췄는지 확인하지 못했습니다. 일시정지 중에 들어온 위치는 거리에 반영되지 않으며, 다시 시작하거나 종료할 때 정리됩니다.'
      );
    }
  };

  const handleResume = async () => {
    if (busyRef.current || lostPending || !isTracking || !isPaused) return;
    setBusyFlag(true);
    let result;
    try {
      result = await resumeTracking(Date.now());
    } catch (e) {
      result = { ok: false, reason: 'resume-failed', message: e?.message ?? String(e) };
    }
    setBusyFlag(false);
    if (result.ok) return;
    if (result.reason === 'permission') {
      Alert.alert(
        '위치 권한이 필요합니다',
        result.canAskAgain
          ? '산책을 이어 기록하려면 위치 권한을 허용해주세요.'
          : '설정에서 위치 권한을 "앱 사용 중 허용"으로 바꿔주세요.',
        result.canAskAgain
          ? [
              { text: '취소', style: 'cancel' },
              { text: '다시 시도', onPress: handleResume },
            ]
          : [
              { text: '취소', style: 'cancel' },
              { text: '설정 열기', onPress: () => Linking.openSettings() },
            ]
      );
    } else if (result.reason !== 'invalid') {
      Alert.alert('다시 시작하지 못했습니다', result.message ?? '위치 수집을 다시 시작하지 못했습니다. 일시정지 상태로 유지됩니다.');
    }
  };

  // discard=true: 저장 여부를 묻지 않고 기록을 버린다("신호가 약합니다" → 취소).
  const handleStop = async (discard = false) => {
    if (busyRef.current) return;
    setBusyFlag(true);
    // 사용자가 처음 종료를 누른 시각 (중단 처리 지연·재시도와 무관하게 보존)
    if (endRequestRef.current === null) endRequestRef.current = Date.now();
    const endedAt = endRequestRef.current;

    let result;
    try {
      result = await stopTracking(endedAt);
    } catch (e) {
      result = { ok: false, reason: 'stop-failed', message: e?.message ?? String(e) };
    }
    if (!result.ok) {
      // 수집이 계속 돌 수 있으므로 산책 중 상태와 임시 기록을 그대로 둔다.
      Alert.alert(
        result.reason === 'stop-unconfirmed' ? '종료를 확인하지 못했습니다' : '종료하지 못했습니다',
        result.message,
        [
          {
            text: '취소',
            style: 'cancel',
            onPress: () => {
              // 서비스가 계속 수집 중임이 확인된 경우(stop-failed)만 종료 요청을 비운다. 이미 멈춘 뒤 읽기가
              // 실패했거나(read-failed) 중단 여부를 확인하지 못한 경우(stop-unconfirmed)는 종료 시각(ref·메타)을
              // 보존해 다음 시도·복원이 같은 시각을 쓰게 한다.
              if (result.reason === 'stop-failed') endRequestRef.current = null;
              setBusyFlag(false);
            },
          },
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
    // 영속화된 종료 시각(재시도 시 처음 값)을 우선 사용한다.
    promptSave(walk, walk.endedAt ?? endedAt);
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
  // 거리는 일시정지 경계로 나눈 구간별 합(경계를 넘어 잇지 않는다). 평균 속도는 이동시간 기준.
  const distance = sumSegmentsDistance(segments);
  const moving =
    isTracking && startedAt ? calculateMovingSeconds(startedAt, now, pauses, pausedAt ?? undefined) : 0;
  const speed = calculateSpeedKmh(distance, moving).toFixed(1);
  const hasPause = isPaused || pauses.length > 0;

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} initialRegion={INITIAL_REGION}>
        {validCoords.length > 0 && (
          <Marker coordinate={validCoords[0]} pinColor="blue" title="출발" />
        )}
        {segments.map(
          (seg, i) =>
            seg.length > 1 && (
              <Polyline key={`seg-${i}`} coordinates={seg} strokeColor="#22c55e" strokeWidth={4} />
            )
        )}
        {isTracking && currentLocation && (
          <CurrentLocationMarker coordinate={currentLocation} heading={heading} />
        )}
      </MapView>

      {acquiring && (
        <View style={styles.acquiringBanner} pointerEvents="none">
          <Text style={styles.acquiringText}>GPS 신호 찾는 중…</Text>
        </View>
      )}

      {isPaused && (
        <View style={styles.acquiringBanner} pointerEvents="none">
          <Text style={styles.acquiringText}>일시정지됨 · 위치를 기록하지 않습니다</Text>
        </View>
      )}

      <View style={styles.statsBar}>
        <StatItem label="거리" value={formatDistance(distance)} />
        <StatItem label="시간" value={formatDuration(elapsed)} />
        {hasPause && <StatItem label="이동" value={formatDuration(moving)} />}
        <StatItem label="속도" value={`${speed}km/h`} />
      </View>

      <View style={styles.buttonArea}>
        {loading || restoring ? (
          <ActivityIndicator size="large" color="#22c55e" />
        ) : isTracking ? (
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[
                styles.btn,
                styles.btnHalf,
                isPaused ? styles.startBtn : styles.pauseBtn,
                (busy || lostPending) && styles.btnDisabled,
              ]}
              onPress={isPaused ? handleResume : handlePause}
              disabled={busy || lostPending}
            >
              <Text style={styles.btnText}>{isPaused ? '다시 시작' : '일시정지'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnHalf, styles.stopBtn, busy && styles.btnDisabled]}
              onPressIn={() => {
                // 종료 요청 영속화 전 강제 종료에 대비해 손가락이 닿는 즉시(서비스·권한 확인 후) 시각을 남긴다.
                // 일시정지 중에는 서비스가 꺼져 있는 것이 정상이라 기록하지 않는다(hook이 'paused'로 건너뜀).
                heartbeat({ transition: false }).catch(() => {});
              }}
              onPress={() => handleStop()}
              disabled={busy}
            >
              <Text style={styles.btnText}>산책 종료</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.btn, styles.startBtn, (busy || lostPending) && styles.btnDisabled]}
            onPress={handleStart}
            disabled={busy || lostPending}
          >
            <Text style={styles.btnText}>산책 시작</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// 현재 위치 표시: 파란 원형 점 + (이동 방향이 있으면) 방향 화살표. 방향은 마커 회전(flat)으로 표현한다.
// 안드로이드 커스텀 마커는 내용이 바뀐 직후에만 잠깐 뷰 변경을 추적하게 해 성능을 지킨다.
function CurrentLocationMarker({ coordinate, heading }) {
  const hasHeading = typeof heading === 'number';
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const id = setTimeout(() => setTrack(false), 400);
    return () => clearTimeout(id);
  }, [hasHeading]);
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={hasHeading ? heading : 0}
      tracksViewChanges={track}
      zIndex={2}
    >
      <View style={styles.locWrap}>
        {hasHeading && <View style={styles.locArrow} />}
        <View style={styles.locDot} />
      </View>
    </Marker>
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
  pauseBtn: { backgroundColor: '#f59e0b' },
  btnRow: { flexDirection: 'row', gap: 12 },
  btnHalf: { flex: 1 },
  btnDisabled: { opacity: 0.5 },
  locWrap: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  locDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2563eb',
    borderWidth: 3,
    borderColor: '#fff',
  },
  locArrow: {
    position: 'absolute',
    top: 1,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 12,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#2563eb',
  },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
