import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MapView, { Polyline, Marker } from 'react-native-maps';
import { formatDistance, formatDuration } from '../utils/distance';
import { getWalkSummary, getWalkMapCoords, calculateSpeedKmh } from '../utils/track';

export default function DetailScreen({ route }) {
  const { walk } = route.params;

  // 새 기록은 유효 샘플로, 구 기록은 저장된 좌표 그대로 그린다. 거리·시간도 새 필드가 있으면 그것을 쓴다.
  const summary = getWalkSummary(walk);
  const coords = getWalkMapCoords(walk);
  const midIndex = Math.floor(coords.length / 2);
  const center = coords[midIndex] || coords[0] || walk.coords?.[0] || { latitude: 37.5665, longitude: 126.978 };

  const date = new Date(walk.date);
  const dateStr = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        initialRegion={{
          ...center,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
        scrollEnabled={false}
        zoomEnabled={false}
      >
        {coords.length > 0 && <Marker coordinate={coords[0]} pinColor="blue" title="출발" />}
        {coords.length > 0 && (
          <Marker coordinate={coords[coords.length - 1]} pinColor="red" title="도착" />
        )}
        {coords.length > 1 && (
          <Polyline coordinates={coords} strokeColor="#22c55e" strokeWidth={4} />
        )}
      </MapView>

      <View style={styles.infoBox}>
        <Text style={styles.dateText}>{dateStr}</Text>
        {walk.quality === 'no-location' && (
          <Text style={styles.noticeText}>위치 기록 없음 (시간만 기록됨)</Text>
        )}
        {walk.quality === 'no-valid-path' && (
          <Text style={styles.noticeText}>경로 측정 불가 (GPS 신호 약함 — 위치 원본과 시간만 기록됨)</Text>
        )}
        {walk.endedAtEstimated && (
          <Text style={styles.noticeText}>종료 시각은 마지막 위치 기록 기준 추정값입니다</Text>
        )}
        <View style={styles.statsRow}>
          <StatItem label="거리" value={formatDistance(summary.distanceMeters)} />
          <View style={styles.divider} />
          <StatItem label="시간" value={formatDuration(summary.elapsedSeconds)} />
          <View style={styles.divider} />
          <StatItem
            label="평균속도"
            value={
              summary.elapsedSeconds > 0
                ? `${calculateSpeedKmh(summary.distanceMeters, summary.elapsedSeconds).toFixed(1)}km/h`
                : '-'
            }
          />
        </View>
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
  container: { flex: 1, backgroundColor: '#fff' },
  map: { flex: 1 },
  infoBox: {
    padding: 20,
    borderTopWidth: 1,
    borderColor: '#e5e7eb',
  },
  dateText: { fontSize: 14, color: '#6b7280', marginBottom: 16 },
  noticeText: { fontSize: 13, color: '#b45309', marginBottom: 12 },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontWeight: '700', color: '#111827' },
  statLabel: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  divider: { width: 1, height: 40, backgroundColor: '#e5e7eb' },
});
